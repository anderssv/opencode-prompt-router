/**
 * Host-independent routing engine shared by the OpenCode V1 and V2 adapters.
 * Holds per-session state and returns preambles; the adapters decide how to
 * deliver them to the model.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { route, extractProjectTokens } from "./core/router";
import { DEFAULT_CONFIG } from "./core/config";
import { createSessionContext, recordTokens, recordMatches, getSessionWeights, recordSkillInjected } from "./core/session";
import { tokenize } from "./core/tokenizer";
import type { SessionContext } from "./core/session";
import type { ScoredSkill } from "./core/types";

export const MATCH_LOG = join(homedir(), "prompt-router.log");

export const PREAMBLE_MARKER = "Before responding, load these skills";

/** Options configurable via opencode.json plugin options. */
export interface PromptRouterOptions {
  /** Minimum TF-IDF score to surface a skill (default: 15) */
  minScore?: number;
  /** Prompts longer than this are skipped (default: 500) */
  maxPromptLength?: number;
  /** Enable debug logging to ~/prompt-router.log and chat (default: false) */
  debug?: boolean;
}

export interface PromptRouterEngine {
  readonly debug: boolean;
  routeUserPrompt(sessionID: string, promptText: string): Promise<string | undefined>;
  routeAssistantText(sessionID: string, assistantText: string): Promise<string | undefined>;
}

export type Log = (msg: string) => void | Promise<void>;

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

const formatScored = (m: ScoredSkill) => ({
  skill: m.skill.name,
  stage1: +m.breakdown!.stage1Score.toFixed(1),
  stage2: +m.breakdown!.stage2Bonus.toFixed(1),
  sessionBonus: m.breakdown!.sessionBonus,
  total: +m.breakdown!.totalScore.toFixed(1),
  hits: m.breakdown!.tokenHits.map((h) => ({
    token: h.token,
    fields: h.fields,
    idf: +h.idf.toFixed(2),
    score: +h.contribution.toFixed(1),
  })),
});

export function logError(hook: string, err: unknown): void {
  try {
    const message = err instanceof Error ? err.message : String(err);
    appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "error", hook, message }) + "\n");
  } catch {
    // Never let the plugin crash the host session
  }
}

export function createPromptRouterEngine(
  directory: string,
  options: PromptRouterOptions | undefined,
  log?: Log,
): PromptRouterEngine {
  const opts = options ?? {};
  const minScore = opts.minScore ?? DEFAULT_CONFIG.minScore;
  const maxPromptLength = opts.maxPromptLength ?? 500;
  const debug = opts.debug ?? !!process.env.PROMPT_ROUTER_DEBUG;

  const sessions = new Map<string, SessionContext>();
  const seededSessions = new Set<string>();

  const agentsMdPaths = [join(directory, "AGENTS.md"), join(directory, ".opencode", "AGENTS.md")];

  const sessionFor = (sessionID: string): SessionContext => {
    let ctx = sessions.get(sessionID);
    if (!ctx) {
      ctx = createSessionContext();
      sessions.set(sessionID, ctx);
    }
    return ctx;
  };

  const seed = async (sessionID: string, sessionCtx: SessionContext, config: typeof DEFAULT_CONFIG) => {
    if (seededSessions.has(sessionID)) return;
    seededSessions.add(sessionID);
    for (const agentsPath of agentsMdPaths) {
      try {
        const content = await readFile(agentsPath, "utf-8");
        // Cap at 20 tokens to avoid noise from very long files
        const capped = (await extractProjectTokens(content, config)).slice(0, 20);
        if (capped.length > 0) {
          for (const t of capped) {
            sessionCtx.pinnedTokens.add(t);
            if (!sessionCtx.tokens.has(t)) sessionCtx.tokens.set(t, { count: 1, lastSeen: 0 });
          }
          if (debug) {
            appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "seed", source: agentsPath, tokens: capped }) + "\n");
          }
        }
        break; // Use first AGENTS.md found
      } catch {
        // File doesn't exist, try next
      }
    }
  };

  return {
    debug,

    async routeUserPrompt(sessionID, promptText) {
      if (!promptText.trim()) return undefined;
      // Skip very long prompts — likely agent-generated tool descriptions, not user intent
      if (promptText.length > maxPromptLength) return undefined;

      const skillPaths = await resolveSkillPaths(directory);
      if (skillPaths.length === 0) return undefined;

      const sessionCtx = sessionFor(sessionID);
      const config = { ...DEFAULT_CONFIG, skillPaths, debug, minScore };
      await seed(sessionID, sessionCtx, config);

      const result = await route(promptText, config, log, sessionCtx);

      sessionCtx.turnInjectedSkills.clear();
      recordTokens(sessionCtx, result.corpusRelevantTokens);
      if (result.matches.length > 0) {
        const skillTokens = result.matches.flatMap((m) => [
          ...tokenize(m.skill.name),
          ...tokenize((m.skill.tags ?? []).join(" ")),
        ]);
        recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
        for (const m of result.matches) {
          sessionCtx.turnInjectedSkills.add(m.skill.name);
          recordSkillInjected(sessionCtx, m.skill.name);
        }
        sessionCtx.lastInjectionAt = sessionCtx.messageCount;
      }

      if (debug) {
        const sessionTokens = Object.fromEntries(
          [...getSessionWeights(sessionCtx).entries()]
            .filter(([, w]) => w >= 0.3)
            .map(([t, w]) => [t, +w.toFixed(1)]),
        );
        const entry: Record<string, unknown> = {
          ts: new Date().toISOString(),
          action: result.preamble ? "inject" : "skip",
          prompt: promptText.replace(/\n/g, " "),
          eligible: result.eligibleTokens,
          session: sessionTokens,
          ms: result.tookMs,
        };
        if (result.matches.length > 0) entry.matches = result.matches.map(formatScored);
        if (result.nearMisses.length > 0) entry.nearMisses = result.nearMisses.map(formatScored);
        appendFileSync(MATCH_LOG, JSON.stringify(entry) + "\n");
      }

      return result.preamble || undefined;
    },

    async routeAssistantText(sessionID, assistantText) {
      const sessionCtx = sessions.get(sessionID);
      if (!sessionCtx) return undefined;
      if (!assistantText.trim()) return undefined;
      const textToScore = assistantText.slice(0, maxPromptLength);

      // Skip if we already scored this exact text (tool loop re-entry)
      const textHash = textToScore.slice(0, 100);
      if (sessionCtx.lastScoredHash === textHash) return undefined;
      sessionCtx.lastScoredHash = textHash;

      const skillPaths = await resolveSkillPaths(directory);
      if (skillPaths.length === 0) return undefined;

      // Higher threshold for assistant text (noisier)
      const config = { ...DEFAULT_CONFIG, skillPaths, debug: false, minScore: Math.round(minScore * 2), disableSessionBonus: true };
      const result = await route(textToScore, config, undefined, sessionCtx);
      if (!result.preamble) return undefined;

      const newMatches = result.matches.filter((m) => !sessionCtx.turnInjectedSkills.has(m.skill.name));
      if (newMatches.length === 0) return undefined;

      recordTokens(sessionCtx, result.corpusRelevantTokens);
      const skillTokens = newMatches.flatMap((m) => [
        ...tokenize(m.skill.name),
        ...tokenize((m.skill.tags ?? []).join(" ")),
      ]);
      recordMatches(sessionCtx, newMatches.map((m) => m.skill.name), skillTokens);
      for (const m of newMatches) {
        sessionCtx.turnInjectedSkills.add(m.skill.name);
        recordSkillInjected(sessionCtx, m.skill.name);
      }
      sessionCtx.lastInjectionAt = sessionCtx.messageCount;

      const names = newMatches.map(({ skill }) => skill.name).join(", ");
      const lines = newMatches.map(({ skill }) => `- ${skill.name}: ${skill.description.slice(0, 120)}`);
      const preamble = `${PREAMBLE_MARKER} using the skill tool: ${names}\n\n${lines.join("\n")}`;

      if (debug) {
        appendFileSync(
          MATCH_LOG,
          JSON.stringify({
            ts: new Date().toISOString(),
            action: "inject-transform",
            assistantText: textToScore.replace(/\n/g, " ").slice(0, 200),
            matches: newMatches.map(formatScored),
            ms: result.tookMs,
          }) + "\n",
        );
      }
      return preamble;
    },
  };
}
