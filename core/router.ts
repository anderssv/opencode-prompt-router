import type { RouterConfig, RouteResult } from "./types";
import { SkillCache } from "./cache";
import { discoverSkills } from "./discovery";
import { scoreSkill, scoreStage2, eligibleTokens } from "./scorer";
import { buildCorpusIndex } from "./corpus";
import { deriveTags } from "./enrich";
import { getSessionWeights } from "./session";
import type { SessionContext } from "./session";

import type { CorpusIndex } from "./corpus";

const globalCache = new SkillCache();

// Corpus index cached by skill-path fingerprint — rebuilt only when skills change
let cachedCorpus: { key: string; index: CorpusIndex } | undefined;

function cachedCorpusIndex(skills: Parameters<typeof buildCorpusIndex>[0]): CorpusIndex {
  const key = skills.map((s) => s.path).sort().join("|");
  if (cachedCorpus?.key === key) return cachedCorpus.index;
  const index = buildCorpusIndex(skills);
  cachedCorpus = { key, index };
  return index;
}

const PREAMBLE_DESC_LIMIT = 120;
const STAGE2_WINDOW_FACTOR = 3;

function formatPreamble(matches: RouteResult["matches"]): string {
  if (matches.length === 0) return "";
  const names = matches.map(({ skill }) => skill.name).join(", ");
  const lines = matches.map(({ skill }) => {
    const desc = skill.description.slice(0, PREAMBLE_DESC_LIMIT);
    return `- ${skill.name}: ${desc}`;
  });
  return `Before responding, load these skills using the skill tool: ${names}\n\n${lines.join("\n")}`;
}

export async function route(
  prompt: string,
  config: RouterConfig,
  log?: (msg: string) => Promise<void> | void,
  sessionCtx?: SessionContext,
): Promise<RouteResult> {
  const start = Date.now();
  const skills = await discoverSkills(config.skillPaths, globalCache);

  if (config.debug) {
    await log?.(`[prompt-router] prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "…" : ""}"`);
    await log?.(`[prompt-router] discovered ${skills.length} skills`);
  }

  const index = cachedCorpusIndex(skills);

  // Enrich skills without explicit tags using corpus-derived tags
  for (const skill of skills) {
    if (!skill.tags || skill.tags.length === 0) {
      skill.tags = deriveTags(skill, skills);
    }
  }

  // Build session-augmented prompt: append weighted session tokens
  let augmentedPrompt = prompt;
  if (sessionCtx && sessionCtx.messageCount > 0) {
    const sessionWeights = getSessionWeights(sessionCtx);
    // Only include session tokens that pass a minimum weight threshold
    const sessionBoostTokens: string[] = [];
    for (const [token, weight] of sessionWeights) {
      if (weight >= 0.3) {
        sessionBoostTokens.push(token);
      }
    }
    if (sessionBoostTokens.length > 0) {
      // Append session tokens so they contribute to scoring
      // (they'll still need to pass eligibility/suppressor checks)
      augmentedPrompt = prompt + " " + sessionBoostTokens.join(" ");
      if (config.debug) {
        await log?.(`[prompt-router] session boost tokens: ${sessionBoostTokens.slice(0, 10).join(", ")}`);
      }
    }
  }

  const scored = skills.map((skill) => {
    const score = scoreSkill(augmentedPrompt, skill, config, index);

    // Stage 2: run for skills near the scoring threshold
    const nearThreshold =
      score >= config.minScore && score <= config.minScore * STAGE2_WINDOW_FACTOR;
    const bonus = nearThreshold ? scoreStage2(augmentedPrompt, skill, config, index) : 0;

    return { skill, score: score + bonus };
  });

  const matches = scored
    .filter(({ score }) => score >= config.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topN);

  const tookMs = Date.now() - start;

  if (config.debug) {
    const matchSummary = matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
    await log?.(`[prompt-router] matches: ${matchSummary} — ${tookMs}ms`);
  }

  return {
    matches,
    preamble: formatPreamble(matches),
    tookMs,
  };
}
