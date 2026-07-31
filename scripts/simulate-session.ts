/**
 * Simulate the prompt-router against a real OpenCode session.
 * Extracts user text parts from the DB and runs them through route().
 * Simulates the transform hook by also scoring assistant messages.
 *
 * Usage: bun run scripts/simulate-session.ts <session_id> [directory]
 *   --all: include assistant messages in direct scoring (old behavior)
 *   (default): user messages scored via chat.message, assistant messages via transform hook
 */
import Database from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { route, extractProjectTokens } from "../core/router";
import { DEFAULT_CONFIG } from "../core/config";
import { createSessionContext, recordTokens, recordMatches, getSessionWeights } from "../core/session";
import { tokenize } from "../core/tokenizer";
import type { SessionContext } from "../core/session";

const DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: bun run scripts/simulate-session.ts <session_id> [directory] [--all]");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// Get session info
const session = db.query("SELECT directory, title FROM session WHERE id = ?").get(sessionId) as any;
if (!session) {
  console.error(`Session ${sessionId} not found`);
  process.exit(1);
}

const directory = process.argv.find((a) => !a.startsWith("-") && a !== sessionId && a !== process.argv[0] && a !== process.argv[1]) ?? session.directory;
const includeAll = process.argv.includes("--all");

console.log(`\n=== Simulating session: ${session.title} ===`);
console.log(`Directory: ${directory}`);
console.log(`Mode: ${includeAll ? "all messages (old)" : "user + transform hook (production)"}\n`);

// Get ALL message parts with role info
const parts = db.query(`
  SELECT m.time_created as msg_time, json_extract(m.data, '$.role') as role, p.data 
  FROM message m 
  JOIN part p ON p.message_id = m.id 
  WHERE m.session_id = ?
  ORDER BY m.time_created ASC, p.time_created ASC
`).all(sessionId) as any[];

// Group into messages with role
interface MsgGroup {
  role: string;
  texts: string[];
}

const messages: MsgGroup[] = [];
let lastMsgTime = 0;

for (const row of parts) {
  const data = JSON.parse(row.data);
  if (row.msg_time !== lastMsgTime) {
    messages.push({ role: row.role, texts: [] });
    lastMsgTime = row.msg_time;
  }
  if (data.type === "text" && !data.tool) {
    messages[messages.length - 1].texts.push(data.text);
  }
}

// Resolve skill paths
const skillPaths = [
  join(homedir(), ".agents", "skills"),
  join(homedir(), ".claude", "skills"),
  join(directory, ".opencode", "skills"),
].filter((p) => existsSync(p));

const config = { ...DEFAULT_CONFIG, skillPaths, debug: false, minScore: DEFAULT_CONFIG.minScore };
const maxPromptLength = 500;

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

// Helper to process a route result
function processResult(result: Awaited<ReturnType<typeof route>>) {
  recordTokens(sessionCtx, result.corpusRelevantTokens);
  if (result.matches.length > 0) {
    const skillTokens = result.matches.flatMap((m) => [
      ...tokenize(m.skill.name),
      ...tokenize((m.skill.tags ?? []).join(" ")),
    ]);
    recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
  }
}

function formatResult(result: Awaited<ReturnType<typeof route>>) {
  const matchStr = result.matches.map((m) => {
    const hits = m.breakdown!.tokenHits.map((h) => `${h.token}[${h.fields.join("+")}]=${h.contribution.toFixed(1)}`).join(", ");
    return `${m.skill.name}(${m.breakdown!.totalScore.toFixed(1)}: s1=${m.breakdown!.stage1Score.toFixed(1)} s2=${m.breakdown!.stage2Bonus.toFixed(1)} sess=${m.breakdown!.sessionBonus} | ${hits})`;
  }).join("; ");
  const nearStr = result.nearMisses
    .filter((m) => m.breakdown!.stage1Score > 0)
    .map((m) => `${m.skill.name}(${m.breakdown!.totalScore.toFixed(1)})`)
    .join(", ");
  return { matchStr, nearStr };
}

// Run simulation
let userInjects = 0;
let userSkips = 0;
let transformInjects = 0;
let transformSkips = 0;
let msgNum = 0;

let lastAssistantText: string | null = null;

for (const msg of messages) {
  const text = msg.texts.join(" ");
  if (!text.trim()) continue;

  if (msg.role === "assistant") {
    // Store for transform hook simulation
    lastAssistantText = text.slice(0, maxPromptLength);

    if (includeAll) {
      // Old mode: score assistant messages directly
      if (text.length <= maxPromptLength) {
        msgNum++;
        const result = await route(text, config, undefined, sessionCtx);
        processResult(result);
        const action = result.preamble ? "INJECT" : "skip";
        if (result.preamble) userInjects++;
        else userSkips++;
        const { matchStr, nearStr } = formatResult(result);
        const display = text.replace(/\n/g, " ").slice(0, 80);
        console.log(`[${String(msgNum).padStart(3)}] ${action.padEnd(6)} [asst] "${display}${text.length > 80 ? "…" : ""}"`);
        if (matchStr) console.log(`        → ${matchStr}`);
        if (nearStr) console.log(`        ~ ${nearStr}`);
      }
    }
    continue;
  }

  // User message — first simulate the transform hook on the last assistant message
  if (!includeAll && lastAssistantText) {
    // Skip if same text already scored (simulates hash check)
    const textHash = lastAssistantText.slice(0, 100);
    if (textHash !== sessionCtx.lastScoredHash) {
      sessionCtx.lastScoredHash = textHash;

      // Higher threshold for transform (1.5x)
      const transformConfig = { ...config, minScore: Math.round(config.minScore * 2), disableSessionBonus: true };
      const transformResult = await route(lastAssistantText, transformConfig, undefined, sessionCtx);
      if (transformResult.preamble) {
        // Filter out skills already injected this turn
        const newMatches = transformResult.matches.filter(
          (m) => !sessionCtx.turnInjectedSkills.has(m.skill.name)
        );
        if (newMatches.length > 0) {
          transformInjects++;
          processResult(transformResult);
          for (const m of newMatches) {
            sessionCtx.turnInjectedSkills.add(m.skill.name);
          }
          sessionCtx.lastInjectionAt = sessionCtx.messageCount;
          const matchStr = newMatches.map((m) => {
            const hits = m.breakdown!.tokenHits.map((h) => `${h.token}[${h.fields.join("+")}]=${h.contribution.toFixed(1)}`).join(", ");
            return `${m.skill.name}(${m.breakdown!.totalScore.toFixed(1)}: s1=${m.breakdown!.stage1Score.toFixed(1)} s2=${m.breakdown!.stage2Bonus.toFixed(1)} sess=${m.breakdown!.sessionBonus} | ${hits})`;
          }).join("; ");
          const display = lastAssistantText.replace(/\n/g, " ").slice(0, 80);
          console.log(`        [transform] "${display}${lastAssistantText.length > 80 ? "…" : ""}"`);
          if (matchStr) console.log(`        → ${matchStr}`);
        } else {
          transformSkips++;
        }
      } else {
        transformSkips++;
      }
    }
    lastAssistantText = null;
  }

  // Score the user message (chat.message hook)
  // Clear turn state for new user message
  sessionCtx.turnInjectedSkills.clear();

  if (text.length > maxPromptLength) continue;
  msgNum++;
  const result = await route(text, config, undefined, sessionCtx);
  processResult(result);
  const action = result.preamble ? "INJECT" : "skip";
  if (result.preamble) {
    userInjects++;
    for (const m of result.matches) {
      sessionCtx.turnInjectedSkills.add(m.skill.name);
    }
    sessionCtx.lastInjectionAt = sessionCtx.messageCount;
  } else {
    userSkips++;
  }
  const { matchStr, nearStr } = formatResult(result);
  const display = text.replace(/\n/g, " ").slice(0, 80);
  console.log(`[${String(msgNum).padStart(3)}] ${action.padEnd(6)} "${display}${text.length > 80 ? "…" : ""}"`);
  if (matchStr) console.log(`        → ${matchStr}`);
  if (nearStr) console.log(`        ~ ${nearStr}`);
}

console.log(`\n=== Results ===`);
console.log(`  User messages: ${userInjects} injections, ${userSkips} skips`);
if (!includeAll) {
  console.log(`  Transform hook: ${transformInjects} injections, ${transformSkips} skips`);
  console.log(`  Total injections: ${userInjects + transformInjects}`);
}
console.log();
db.close();
