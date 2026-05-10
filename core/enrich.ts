/**
 * Corpus enrichment: derive tags from skill content at index time.
 *
 * Skills with explicit frontmatter tags are used as-is. Skills without
 * explicit tags get auto-derived tags from their body content.
 */
import type { Skill } from "./types";
import { tokenize } from "./tokenizer";

const MAX_DERIVED_TAGS = 8;
const MIN_BODY_TOKENS = 10;

/**
 * Derive tags for a skill by finding tokens unique to its body compared
 * to the rest of the corpus. Excludes tokens already in name/description.
 */
export function deriveTags(skill: Skill, allSkills: Skill[]): string[] {
  const bodyTokens = tokenize(skill.raw);
  if (bodyTokens.length < MIN_BODY_TOKENS) return [];

  // Tokens already in name/description — don't duplicate
  const identityTokens = new Set([
    ...tokenize(skill.name),
    ...tokenize(skill.description),
  ]);

  // Count token frequency in this skill's body
  const localFreq = new Map<string, number>();
  for (const t of bodyTokens) {
    if (identityTokens.has(t)) continue;
    if (t.length < 3) continue;
    localFreq.set(t, (localFreq.get(t) ?? 0) + 1);
  }

  // Count how many OTHER skills contain each token
  const globalDf = new Map<string, number>();
  for (const other of allSkills) {
    if (other.path === skill.path) continue;
    const otherTokens = new Set(tokenize(other.raw));
    for (const t of otherTokens) {
      globalDf.set(t, (globalDf.get(t) ?? 0) + 1);
    }
  }

  // Score: high local frequency + low global document frequency = good tag
  const candidates: { token: string; score: number }[] = [];
  for (const [token, freq] of localFreq) {
    const df = globalDf.get(token) ?? 0;
    const score = freq / (df + 1);
    if (score > 0.5) {
      candidates.push({ token, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_DERIVED_TAGS).map((c) => c.token);
}
