import type { Skill } from "./types";
import { tokenize } from "./tokenizer";

export interface CorpusIndex {
  idf(token: string): number;
  readonly size: number;
}

function skillTokenSet(skill: Skill): Set<string> {
  return new Set([
    ...tokenize(skill.name),
    ...tokenize(skill.description),
    ...tokenize((skill.tags ?? []).join(" ")),
  ]);
}

export function buildCorpusIndex(skills: Skill[]): CorpusIndex {
  const N = skills.length;
  const df = new Map<string, number>();

  for (const skill of skills) {
    for (const token of skillTokenSet(skill)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  return {
    size: N,
    idf(token: string): number {
      // Unknown tokens treated as df=1 (max signal, same as a token unique to one skill)
      const docFreq = df.get(token) ?? 1;
      return Math.log(N / docFreq);
    },
  };
}
