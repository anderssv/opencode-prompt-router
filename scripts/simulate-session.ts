/**
 * Simulate the prompt-router against a real OpenCode session.
 * Extracts user text parts from the DB and runs them through route().
 *
 * Usage: bun run scripts/simulate-session.ts <session_id> [directory]
 *   directory: workspace directory for AGENTS.md seeding (defaults to session's directory)
 */
import Database from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { route, extractProjectTokens } from "../core/router";
import { DEFAULT_CONFIG } from "../core/config";
import { createSessionContext, recordTokens, recordMatches, getSessionWeights } from "../core/session";
import { tokenize } from "../core/tokenizer";
import type { SessionContext } from "../core/session";

const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: bun run scripts/simulate-session.ts <session_id> [directory]");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// Get session info
const session = db.query("SELECT directory, title FROM session WHERE id = ?").get(sessionId) as any;
if (!session) {
  console.error(`Session ${sessionId} not found`);
  process.exit(1);
}

const directory = process.argv[3] ?? session.directory;
console.log(`\n=== Simulating session: ${session.title} ===`);
console.log(`Directory: ${directory}\n`);

const includeAll = process.argv.includes("--all");

// Get message parts in order (user-only or all)
const roleFilter = includeAll ? "" : "AND json_extract(m.data, '$.role') = 'user'";
const parts = db.query(`
  SELECT m.time_created as msg_time, p.data 
  FROM message m 
  JOIN part p ON p.message_id = m.id 
  WHERE m.session_id = ? ${roleFilter}
  ORDER BY m.time_created ASC, p.time_created ASC
`).all(sessionId) as any[];

// Extract user text messages (first text part of each message group)
const userMessages: string[] = [];
let lastMsgTime = 0;
let currentMsgTexts: string[] = [];

for (const row of parts) {
  const data = JSON.parse(row.data);
  if (row.msg_time !== lastMsgTime) {
    if (currentMsgTexts.length > 0) {
      userMessages.push(currentMsgTexts.join(" "));
    }
    currentMsgTexts = [];
    lastMsgTime = row.msg_time;
  }
  if (data.type === "text" && !data.tool) {
    currentMsgTexts.push(data.text);
  }
}
if (currentMsgTexts.length > 0) {
  userMessages.push(currentMsgTexts.join(" "));
}

// Filter to short messages (user prompts, not assistant responses)
const maxPromptLength = 500;
const prompts = userMessages.filter((m) => m.length <= maxPromptLength && m.trim().length > 0);

console.log(`Found ${userMessages.length} messages, ${prompts.length} within prompt length limit\n`);

// Resolve skill paths
const skillPaths = [
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".claude", "skills"),
  join(directory, ".opencode", "skills"),
].filter((p) => {
  try { readFileSync(join(p, "."), "utf-8"); return false; } catch (e: any) {
    return e.code === "EISDIR" || e.code === "ENOENT";
  }
});

// Actually check if dirs exist
import { existsSync } from "node:fs";
const validSkillPaths = skillPaths.filter((p) => existsSync(p));

const config = { ...DEFAULT_CONFIG, skillPaths: validSkillPaths, debug: false, minScore: DEFAULT_CONFIG.minScore };

// Create session context and seed with AGENTS.md
const sessionCtx = createSessionContext();
const agentsPaths = [join(directory, "AGENTS.md"), join(directory, ".opencode", "AGENTS.md")];
for (const ap of agentsPaths) {
  try {
    const content = readFileSync(ap, "utf-8");
    const projectTokens = await extractProjectTokens(content, config);
    const capped = projectTokens.slice(0, 20);
    for (const t of capped) {
      sessionCtx.pinnedTokens.add(t);
      if (!sessionCtx.tokens.has(t)) {
        sessionCtx.tokens.set(t, { count: 1, lastSeen: 0 });
      }
    }
    console.log(`[seed] ${ap}: ${capped.join(", ")}\n`);
    break;
  } catch {
    // not found
  }
}

// Run each prompt through the router
let injectCount = 0;
let skipCount = 0;

for (let i = 0; i < prompts.length; i++) {
  const prompt = prompts[i].replace(/\n/g, " ").slice(0, 200);
  const result = await route(prompts[i], config, undefined, sessionCtx);

  // Record tokens (same as plugin does)
  recordTokens(sessionCtx, result.corpusRelevantTokens);
  if (result.matches.length > 0) {
    const skillTokens = result.matches.flatMap((m) => [
      ...tokenize(m.skill.name),
      ...tokenize((m.skill.tags ?? []).join(" ")),
    ]);
    recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
  }

  const action = result.preamble ? "INJECT" : "skip";
  if (result.preamble) injectCount++;
  else skipCount++;

  const matchStr = result.matches.map((m) => {
    const hits = m.breakdown!.tokenHits.map((h) => `${h.token}[${h.fields.join("+")}]=${h.contribution.toFixed(1)}`).join(", ");
    return `${m.skill.name}(${m.breakdown!.totalScore.toFixed(1)}: stage1=${m.breakdown!.stage1Score.toFixed(1)} s2=${m.breakdown!.stage2Bonus.toFixed(1)} sess=${m.breakdown!.sessionBonus} | ${hits})`;
  }).join("; ");

  const nearStr = result.nearMisses
    .filter((m) => m.breakdown!.stage1Score > 0)
    .map((m) => `${m.skill.name}(${m.breakdown!.totalScore.toFixed(1)})`)
    .join(", ");

  console.log(`[${String(i + 1).padStart(3)}] ${action.padEnd(6)} "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}"`);
  if (matchStr) console.log(`        → ${matchStr}`);
  if (nearStr) console.log(`        ~ ${nearStr}`);
}

console.log(`\n=== Results: ${injectCount} injections, ${skipCount} skips ===\n`);
db.close();
