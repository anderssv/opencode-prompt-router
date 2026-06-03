/**
 * Prompt Router — OpenCode plugin
 *
 * On each user message, scores all discovered SKILL.md files against the
 * prompt and injects a preamble listing the top matching skills as a
 * synthetic TextPart prepended to the message parts.
 *
 * Skill paths auto-detected (in order):
 *   ~/.agents/skills/      (shared cross-agent skills)
 *   ~/.claude/skills/      (Claude Code skills, if present)
 *   <workdir>/.opencode/skills/  (project-local skills)
 */
import type { Plugin } from "@opencode-ai/plugin";
import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { route, extractProjectTokens } from "./core/router";
import { DEFAULT_CONFIG } from "./core/config";
import { createSessionContext, recordTokens, recordMatches, getSessionWeights } from "./core/session";
import { tokenize } from "./core/tokenizer";
import type { SessionContext } from "./core/session";

const MATCH_LOG = join(homedir(), "prompt-router.log");

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveSkillPaths(directory: string): Promise<string[]> {
  const candidates = [
    join(homedir(), ".agents", "skills"),
    join(homedir(), ".claude", "skills"),
    join(directory, ".opencode", "skills"),
  ];
  const found: string[] = [];
  for (const p of candidates) {
    if (await exists(p)) found.push(p);
  }
  return found;
}

/** Options configurable via opencode.json:
 *   ["opencode-prompt-router", { "minScore": 20, "maxPromptLength": 300 }]
 */
interface PromptRouterOptions {
  /** Minimum TF-IDF score to surface a skill (default: 15) */
  minScore?: number;
  /** Prompts longer than this are skipped (default: 500) */
  maxPromptLength?: number;
  /** Enable debug logging to ~/prompt-router.log and chat (default: false) */
  debug?: boolean;
}

export const PromptRouter: Plugin = async ({ directory, client }, options?: PromptRouterOptions) => {
  const opts = (options ?? {}) as PromptRouterOptions;
  const minScore = opts.minScore ?? DEFAULT_CONFIG.minScore;
  const maxPromptLength = opts.maxPromptLength ?? 500;
  const debug = opts.debug ?? !!process.env.PROMPT_ROUTER_DEBUG;

  // Session context map — persists across messages within the plugin lifetime
  const sessions = new Map<string, SessionContext>();
  // Track whether we've seeded a session with project tokens
  const seededSessions = new Set<string>();

  // AGENTS.md locations to check for project context
  const agentsMdPaths = [
    join(directory, "AGENTS.md"),
    join(directory, ".opencode", "AGENTS.md"),
  ];

  const log = (msg: string) =>
    client.app.log({ body: { service: "prompt-router", level: "info", message: msg } });

  return {
    "chat.message": async (input, output) => {
      // Extract plain text from existing parts to form the routing prompt
      const promptText = output.parts
        .filter((p) => p.type === "text")
        .map((p) => ("text" in p ? p.text : ""))
        .join(" ");

      if (!promptText.trim()) return;

      // Skip very long prompts — likely agent-generated tool descriptions, not user intent
      if (promptText.length > maxPromptLength) return;

      const skillPaths = await resolveSkillPaths(directory);
      if (skillPaths.length === 0) return;

      // Get or create session context
      const sessionID = input.sessionID;
      if (!sessions.has(sessionID)) {
        sessions.set(sessionID, createSessionContext());
      }
      const sessionCtx = sessions.get(sessionID)!;

      const config = { ...DEFAULT_CONFIG, skillPaths, debug, minScore };

      // Seed session with AGENTS.md project tokens (once per session)
      if (!seededSessions.has(sessionID)) {
        seededSessions.add(sessionID);
        for (const agentsPath of agentsMdPaths) {
          try {
            const content = await readFile(agentsPath, "utf-8");
            const projectTokens = await extractProjectTokens(content, config);
            // Cap at 20 tokens to avoid noise from very long files
            const capped = projectTokens.slice(0, 20);
            if (capped.length > 0) {
              // Pin these as permanent session tokens
              for (const t of capped) {
                sessionCtx.pinnedTokens.add(t);
                if (!sessionCtx.tokens.has(t)) {
                  sessionCtx.tokens.set(t, { count: 1, lastSeen: 0 });
                }
              }
              if (debug) {
                appendFileSync(MATCH_LOG, `${new Date().toISOString()} [project] seeded from ${agentsPath}: ${capped.join(", ")}\n`);
              }
            }
            break; // Use first AGENTS.md found
          } catch {
            // File doesn't exist, try next
          }
        }
      }

      const result = await route(promptText, config, log, sessionCtx);

      // Record only corpus-relevant tokens (those in skill name/tags) into session
      recordTokens(sessionCtx, result.corpusRelevantTokens);
      if (result.matches.length > 0) {
        // Pin matched skill name/tag tokens so they persist for the session
        const skillTokens = result.matches.flatMap((m) => [
          ...tokenize(m.skill.name),
          ...tokenize((m.skill.tags ?? []).join(" ")),
        ]);
        recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
      }

      if (debug) {
        if (result.preamble) {
          const ts = new Date().toISOString();
          const sessionTokens = [...getSessionWeights(sessionCtx).entries()]
            .filter(([, w]) => w >= 0.3)
            .map(([t, w]) => `${t}(${w.toFixed(1)})`)
            .join(", ") || "(none)";
          const prompt = promptText.replace(/\n/g, " ");
          appendFileSync(MATCH_LOG, `${ts} [session] tokens: ${sessionTokens}\n`);
          appendFileSync(MATCH_LOG, `${ts} [prompt] ${prompt}\n`);
          appendFileSync(MATCH_LOG, `${ts} [eligible] ${result.eligibleTokens.join(", ")}\n`);
          for (const m of result.matches) {
            const bd = m.breakdown!;
            const hits = bd.tokenHits.map((h) =>
              `${h.token}[${h.fields.join("+")}]*${h.idf.toFixed(2)}=${h.contribution.toFixed(1)}`
            ).join(", ");
            appendFileSync(MATCH_LOG, `${ts} [score] ${m.skill.name}: stage1=${bd.stage1Score.toFixed(1)} stage2=${bd.stage2Bonus.toFixed(1)} session=${bd.sessionBonus} total=${bd.totalScore.toFixed(1)} | ${hits}\n`);
          }
          appendFileSync(MATCH_LOG, `${ts} [inject] ${result.matches.map((m) => m.skill.name).join(", ")} (${result.tookMs}ms)\n`);
        }
      }

      if (!result.preamble) return;

      // Inject preamble as a synthetic text part at the start of the message.
      // When debug is on, show it in the chat so you can see what the router picked.
      const preamblePart = {
        id: `prt_prompt-router-${Date.now()}`,
        sessionID: input.sessionID,
        messageID: input.messageID ?? "",
        type: "text" as const,
        text: result.preamble + "\n\n",
        synthetic: !config.debug,
      };

      output.parts.push(preamblePart);
    },
  };
};
