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
import { access } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { route } from "./core/router";
import { DEFAULT_CONFIG } from "./core/config";
import { createSessionContext, recordTokens, recordMatches } from "./core/session";
import { eligibleTokens } from "./core/scorer";
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
      const result = await route(promptText, config, log, sessionCtx);

      // Record current prompt tokens and matches into session context
      const currentTokens = eligibleTokens(promptText, config);
      recordTokens(sessionCtx, currentTokens);
      if (result.matches.length > 0) {
        recordMatches(sessionCtx, result.matches.map((m) => m.skill.name));
      }

      if (debug) {
        const matches = result.matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
        const prompt = promptText.replace(/\n/g, " ");
        appendFileSync(MATCH_LOG, `${new Date().toISOString()}  ${prompt}  →  ${matches}  (${result.tookMs}ms)\n`);
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
