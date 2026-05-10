import { describe, test, expect } from "bun:test";
import { buildCorpusIndex } from "../core/corpus";
import type { Skill } from "../core/types";

function makeSkill(name: string, description: string, raw = ""): Skill {
  return {
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    raw: raw || `---\nname: ${name}\ndescription: ${description}\n---\n`,
  };
}

describe("buildCorpusIndex", () => {
  test("idf of token appearing in all skills is near zero", () => {
    const skills = [
      makeSkill("skill-a", "Use when doing thing A."),
      makeSkill("skill-b", "Use when doing thing B."),
      makeSkill("skill-c", "Use when doing thing C."),
    ];

    const index = buildCorpusIndex(skills);

    // idf = log(N / df) = log(3/3) = log(1) = 0
    expect(index.idf("use")).toBeCloseTo(0);
  });

  test("idf of token appearing in one skill is log(N)", () => {
    const skills = [
      makeSkill("skill-a", "Use terraform for infra."),
      makeSkill("skill-b", "Use when doing thing B."),
      makeSkill("skill-c", "Use when doing thing C."),
    ];

    const index = buildCorpusIndex(skills);

    // idf = log(3 / 1) ≈ 1.099
    expect(index.idf("terraform")).toBeCloseTo(Math.log(3));
  });

  test("idf of unknown token is log(N) — treated as appearing in 1 doc", () => {
    const skills = [
      makeSkill("skill-a", "Thing A."),
      makeSkill("skill-b", "Thing B."),
      makeSkill("skill-c", "Thing C."),
    ];

    const index = buildCorpusIndex(skills);

    expect(index.idf("completelyrare")).toBeCloseTo(Math.log(3));
  });


});
