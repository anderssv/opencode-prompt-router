import type { RouterConfig, RouteResult } from "./types";
import { SkillCache } from "./cache";
import { discoverSkills } from "./discovery";
import { scoreSkill, scoreStage2, eligibleTokens } from "./scorer";
import { buildCorpusIndex } from "./corpus";
import { deriveTags } from "./enrich";
import { tokenize } from "./tokenizer";
import { getSessionWeights } from "./session";
import type { SessionContext } from "./session";

import type { CorpusIndex } from "./corpus";
import type { Skill } from "./types";

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
const SESSION_AFFINITY_BONUS = 5;

/**
 * Compute a session affinity bonus for a skill. If the skill's name or tags
 * overlap with recent session tokens (weight >= 0.3), it gets a flat bonus.
 * This helps short follow-up messages surface contextually relevant skills.
 */
function sessionBonus(skill: Skill, sessionWeights: Map<string, number>): number {
  if (sessionWeights.size === 0) return 0;

  const nameTokens = new Set(tokenize(skill.name));
  const tagTokens = new Set(tokenize((skill.tags ?? []).join(" ")));

  for (const [token, weight] of sessionWeights) {
    if (weight < 0.3) continue;
    if (nameTokens.has(token) || tagTokens.has(token)) {
      return SESSION_AFFINITY_BONUS;
    }
  }
  return 0;
}

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

  // Compute session affinity weights (once, reused per skill)
  const sessionWeights = sessionCtx && sessionCtx.messageCount > 0
    ? getSessionWeights(sessionCtx)
    : new Map<string, number>();

  const scored = skills.map((skill) => {
    const score = scoreSkill(prompt, skill, config, index);

    // Stage 2: run for skills near the scoring threshold
    const nearThreshold =
      score >= config.minScore && score <= config.minScore * STAGE2_WINDOW_FACTOR;
    const bonus = nearThreshold ? scoreStage2(prompt, skill, config, index) : 0;

    // Session affinity: flat bonus if skill name/tags overlap with session context
    const sessBonus = sessionBonus(skill, sessionWeights);

    return { skill, score: score + bonus + sessBonus };
  });

  const excludeSet = new Set(config.excludeSkills ?? []);

  const matches = scored
    .filter(({ skill, score }) => score >= config.minScore && !excludeSet.has(skill.name))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topN);

  const tookMs = Date.now() - start;

  // Compute corpus-relevant tokens: prompt tokens that appear in any skill's name/tags
  const allNameTagTokens = new Set<string>();
  for (const skill of skills) {
    for (const t of tokenize(skill.name)) allNameTagTokens.add(t);
    for (const t of tokenize((skill.tags ?? []).join(" "))) allNameTagTokens.add(t);
  }
  const promptTokens = eligibleTokens(prompt, config, index);
  const corpusRelevantTokens = promptTokens.filter((t) => allNameTagTokens.has(t));

  if (config.debug) {
    const matchSummary = matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
    await log?.(`[prompt-router] matches: ${matchSummary} — ${tookMs}ms`);
  }

  return {
    matches,
    preamble: formatPreamble(matches),
    tookMs,
    corpusRelevantTokens,
  };
}
