import type { RouterConfig } from "./types";

// Words that are common in English but rare in the skill corpus, causing IDF
// to over-value them. The IDF floor handles corpus-common words automatically;
// this list only covers the IDF blind spot: words common in natural language
// but rare across skill names/descriptions.
const SUPPRESSORS: string[] = [
  // Generic verbs/actions
  "skill", "help", "build", "make", "add",
  // Ambiguous nouns (common English meaning ≠ skill meaning)
  "event", "events",
  // Adjectives/adverbs
  "good", "better", "well", "new",
  // Pronouns, articles, connectives
  "you", "are", "the", "any", "they", "its",
  "that", "this", "also", "can", "not", "how",
  "too", "out", "off", "has", "was", "been",
  "just", "want", "some", "very", "than",
];

export const DEFAULT_CONFIG: RouterConfig = {
  skillPaths: [],
  topN: 3,
  minScore: 15,
  weights: {
    name: 3,
    tags: 2,
    description: 1,
  },
  suppressors: SUPPRESSORS,
  idfFloor: 1.5,
  maxMatchingTokens: 4,
  minMatchingTokens: 2,
  stage2CharLimit: 6000,
};
