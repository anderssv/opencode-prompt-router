import type { Skill, RouterConfig } from "./types";
import type { CorpusIndex } from "./corpus";
import { tokenize } from "./tokenizer";

function fieldTokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Returns the subset of prompt tokens eligible for scoring, after applying
 * the IDF floor and suppressor list. Both stage 1 and stage 2 use this so
 * that eligibility logic stays in one place.
 */
export function eligibleTokens(
  prompt: string,
  config: RouterConfig,
  index?: CorpusIndex,
): string[] {
  const suppressorSet = new Set(config.suppressors);
  return tokenize(prompt).filter((t) => {
    if (index && index.size >= 10 && index.idf(t) < config.idfFloor) return false;
    if (suppressorSet.has(t)) return false;
    return true;
  });
}

const STAGE2_HIT_CAP = 5;
const STAGE2_HIT_WEIGHT = 0.4;

export function scoreStage2(
  prompt: string,
  skill: Skill,
  config: RouterConfig,
  index?: CorpusIndex,
): number {
  const eligible = new Set(eligibleTokens(prompt, config, index));

  const body = skill.raw.slice(0, config.stage2CharLimit);
  const bodyTokens = tokenize(body);

  // Count frequency of each eligible prompt token in the body
  const tokenCounts = new Map<string, number>();
  for (const t of bodyTokens) {
    if (eligible.has(t)) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }

  let bonus = 0;
  for (const count of tokenCounts.values()) {
    bonus += Math.min(count, STAGE2_HIT_CAP) * STAGE2_HIT_WEIGHT;
  }
  return bonus;
}

export function scoreSkill(
  prompt: string,
  skill: Skill,
  config: RouterConfig,
  index?: CorpusIndex,
): number {
  const { weights } = config;
  const tokens = eligibleTokens(prompt, config, index);

  const nameTokens = fieldTokenSet(skill.name);
  const descTokens = fieldTokenSet(skill.description);
  const tagTokens = fieldTokenSet((skill.tags ?? []).join(" "));

  // Collect per-token contributions, then keep only top N.
  // This prevents long vague prompts from accumulating noise.
  const contributions: number[] = [];
  let hasHighSignalMatch = false;

  for (const t of tokens) {
    const idf = index ? index.idf(t) : 1;

    const inName = nameTokens.has(t);
    const inTags = tagTokens.has(t);
    const inDesc = descTokens.has(t);

    if (inName || inTags) hasHighSignalMatch = true;

    let tokenScore = 0;
    if (inName) tokenScore += weights.name * idf;
    if (inTags) tokenScore += weights.tags * idf;
    if (inDesc) tokenScore += weights.description * idf;

    if (tokenScore > 0) contributions.push(tokenScore);
  }

  // Description-only matches are too noisy — generic words like "cli" or
  // "data" appear in many descriptions. Require at least one token to hit
  // a high-signal field (name or tags) before counting.
  if (!hasHighSignalMatch) return 0;

  // Require a minimum number of distinct matching tokens to avoid
  // single-token false positives from long vague prompts (e.g. "cli" alone
  // surfacing playwright-cli). Short prompts with few eligible tokens are
  // exempt — they're likely targeted.
  const minTokens = config.minMatchingTokens ?? 1;
  const eligibleCount = new Set(tokens).size;
  if (eligibleCount >= 5 && contributions.length < minTokens) return 0;

  // Sort descending and sum only top N contributions
  contributions.sort((a, b) => b - a);
  const topN = config.maxMatchingTokens ?? contributions.length;
  let score = 0;
  for (let i = 0; i < Math.min(topN, contributions.length); i++) {
    score += contributions[i];
  }

  return score;
}
