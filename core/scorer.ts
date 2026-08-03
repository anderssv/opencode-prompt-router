import type { Skill, RouterConfig, TokenHit } from "./types";
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

export interface ScoreSkillResult {
  score: number;
  tokenHits: TokenHit[];
}

export function scoreSkill(
  prompt: string,
  skill: Skill,
  config: RouterConfig,
  index?: CorpusIndex,
): ScoreSkillResult {
  const { weights } = config;
  const tokens = eligibleTokens(prompt, config, index);

  const nameTokens = fieldTokenSet(skill.name);
  const descTokens = fieldTokenSet(skill.description);
  const tagTokens = fieldTokenSet((skill.tags ?? []).join(" "));

  // Collect per-token contributions, then keep only top N.
  // This prevents long vague prompts from accumulating noise.
  const hits: TokenHit[] = [];
  let hasHighSignalMatch = false;
  const tokenCounts = new Map<string, number>();

  for (const t of tokens) {
    // Cap each token at 2 contributions to prevent repetition inflation
    const count = tokenCounts.get(t) ?? 0;
    if (count >= 2) continue;
    tokenCounts.set(t, count + 1);

    const idf = index ? index.idf(t) : 1;

    const inName = nameTokens.has(t);
    const inTags = tagTokens.has(t);
    const inDesc = descTokens.has(t);

    if (inName || inTags) hasHighSignalMatch = true;

    let tokenScore = 0;
    const fields: TokenHit["fields"] = [];
    if (inName) { tokenScore += weights.name * idf; fields.push("name"); }
    if (inTags) { tokenScore += weights.tags * idf; fields.push("tags"); }
    if (inDesc) { tokenScore += weights.description * idf; fields.push("description"); }

    if (tokenScore > 0) hits.push({ token: t, fields, idf, contribution: tokenScore });
  }

  if (!hasHighSignalMatch) return { score: 0, tokenHits: [] };

  const minTokens = config.minMatchingTokens ?? 1;
  const eligibleCount = new Set(tokens).size;
  // Count distinct matching tokens (not total hits — same token twice doesn't count as 2)
  const distinctHitTokens = new Set(hits.map(h => h.token)).size;
  if (eligibleCount >= 5 && distinctHitTokens < minTokens) return { score: 0, tokenHits: [] };

  // Sort descending and sum only top N contributions
  hits.sort((a, b) => b.contribution - a.contribution);
  const topN = config.maxMatchingTokens ?? hits.length;
  let score = 0;
  for (let i = 0; i < Math.min(topN, hits.length); i++) {
    score += hits[i].contribution;
  }

  return { score, tokenHits: hits.slice(0, topN) };
}
