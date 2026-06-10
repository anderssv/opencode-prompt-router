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
import type { Plugin, PluginModule } from "@opencode-ai/plugin";
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
  // Track last seen session ID for the transform hook (which has no sessionID in input)
  let lastSeenSessionID: string | undefined;

  // AGENTS.md locations to check for project context
  const agentsMdPaths = [
    join(directory, "AGENTS.md"),
    join(directory, ".opencode", "AGENTS.md"),
  ];

  const log = (msg: string) =>
    client.app.log({ body: { service: "prompt-router", level: "info", message: msg } });

  return {
    "chat.message": async (input, output) => {
      try {
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
      lastSeenSessionID = sessionID;
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
                appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "seed", source: agentsPath, tokens: capped }) + "\n");
              }
            }
            break; // Use first AGENTS.md found
          } catch {
            // File doesn't exist, try next
          }
        }
      }

      const result = await route(promptText, config, log, sessionCtx);

      // Clear turn state for new user message
      sessionCtx.turnInjectedSkills.clear();

      // Record only corpus-relevant tokens (those in skill name/tags) into session
      recordTokens(sessionCtx, result.corpusRelevantTokens);
      if (result.matches.length > 0) {
        // Pin matched skill name/tag tokens so they persist for the session
        const skillTokens = result.matches.flatMap((m) => [
          ...tokenize(m.skill.name),
          ...tokenize((m.skill.tags ?? []).join(" ")),
        ]);
        recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
        // Track what we injected this turn
        for (const m of result.matches) {
          sessionCtx.turnInjectedSkills.add(m.skill.name);
        }
        sessionCtx.lastInjectionAt = sessionCtx.messageCount;
      }

      if (debug) {
        const ts = new Date().toISOString();
        const sessionTokens = Object.fromEntries(
          [...getSessionWeights(sessionCtx).entries()]
            .filter(([, w]) => w >= 0.3)
            .map(([t, w]) => [t, +w.toFixed(1)])
        );
        const formatScored = (m: typeof result.matches[0]) => ({
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
        const entry: Record<string, unknown> = {
          ts,
          action: result.preamble ? "inject" : "skip",
          prompt: promptText.replace(/\n/g, " "),
          eligible: result.eligibleTokens,
          session: sessionTokens,
          ms: result.tookMs,
        };
        if (result.matches.length > 0) {
          entry.matches = result.matches.map(formatScored);
        }
        if (result.nearMisses.length > 0) {
          entry.nearMisses = result.nearMisses.map(formatScored);
        }
        appendFileSync(MATCH_LOG, JSON.stringify(entry) + "\n");
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
      } catch (err) {
        // Never let the plugin crash the host session
        try {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "error", hook: "chat.message", message: msg }) + "\n");
        } catch {
          // Even logging failed — swallow silently
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = output.messages;
        if (messages.length < 2) return;

        // Need session context
        const sessionID = lastSeenSessionID;
        if (!sessionID) return;
        if (!sessions.has(sessionID)) return;
        const sessionCtx = sessions.get(sessionID)!;

        // Find the last assistant message
        let lastAssistantIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if ((messages[i].info as any).role === "assistant") {
            lastAssistantIdx = i;
            break;
          }
        }
        if (lastAssistantIdx === -1) return;

        // Extract text from last assistant message
        const assistantParts = messages[lastAssistantIdx].parts;
        const assistantText = assistantParts
          .filter((p) => p.type === "text")
          .map((p) => ("text" in p ? (p as any).text : ""))
          .join(" ");

        if (!assistantText.trim()) return;
        const textToScore = assistantText.slice(0, maxPromptLength);

        // Skip if we already scored this exact text (tool loop re-entry)
        const textHash = textToScore.slice(0, 100);
        if (sessionCtx.lastScoredHash === textHash) return;
        sessionCtx.lastScoredHash = textHash;

        const skillPaths = await resolveSkillPaths(directory);
        if (skillPaths.length === 0) return;

        // Higher threshold for assistant text (noisier)
        const transformMinScore = Math.round(minScore * 1.5);
        const config = { ...DEFAULT_CONFIG, skillPaths, debug: false, minScore: transformMinScore };
        const result = await route(textToScore, config, undefined, sessionCtx);

        if (!result.preamble) return;

        // Filter out skills already injected this turn by chat.message
        const newMatches = result.matches.filter(
          (m) => !sessionCtx.turnInjectedSkills.has(m.skill.name)
        );
        if (newMatches.length === 0) return;

        // Record tokens from assistant message into session context
        recordTokens(sessionCtx, result.corpusRelevantTokens);
        const skillTokens = newMatches.flatMap((m) => [
          ...tokenize(m.skill.name),
          ...tokenize((m.skill.tags ?? []).join(" ")),
        ]);
        recordMatches(sessionCtx, newMatches.map((m) => m.skill.name), skillTokens);
        for (const m of newMatches) {
          sessionCtx.turnInjectedSkills.add(m.skill.name);
        }
        sessionCtx.lastInjectionAt = sessionCtx.messageCount;

        // Find the last user message to inject into
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if ((messages[i].info as any).role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx === -1) return;

        // Only inject if the last user message doesn't already have a router preamble
        const userParts = messages[lastUserIdx].parts;
        const alreadyInjected = userParts.some(
          (p) => p.type === "text" && ("text" in p) && (p as any).text?.includes("Before responding, load these skills")
        );
        if (alreadyInjected) return;

        // Build preamble from new matches only
        const names = newMatches.map(({ skill }) => skill.name).join(", ");
        const lines = newMatches.map(({ skill }) => {
          const desc = skill.description.slice(0, 120);
          return `- ${skill.name}: ${desc}`;
        });
        const preamble = `Before responding, load these skills using the skill tool: ${names}\n\n${lines.join("\n")}`;

        // Inject preamble into the last user message
        const preamblePart = {
          id: `prt_prompt-router-transform-${Date.now()}`,
          sessionID,
          messageID: "",
          type: "text" as const,
          text: preamble + "\n\n",
          synthetic: true,
        };
        messages[lastUserIdx].parts.push(preamblePart);

        if (debug) {
          const ts = new Date().toISOString();
          const entry = {
            ts,
            action: "inject-transform",
            assistantText: textToScore.replace(/\n/g, " ").slice(0, 200),
            matches: newMatches.map((m) => ({
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
            })),
            ms: result.tookMs,
          };
          appendFileSync(MATCH_LOG, JSON.stringify(entry) + "\n");
        }
      } catch (err) {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "error", hook: "transform", message: msg }) + "\n");
        } catch {
          // swallow
        }
      }
    },
  };
};

export const module: PluginModule = {
  id: "opencode-prompt-router",
  server: PromptRouter,
};
