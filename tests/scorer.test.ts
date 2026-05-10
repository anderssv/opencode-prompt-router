import { describe, test, expect } from "bun:test";
import { scoreSkill, scoreStage2 } from "../core/scorer";
import { buildCorpusIndex } from "../core/corpus";
import { DEFAULT_CONFIG } from "../core/config";
import type { Skill } from "../core/types";

// Unit tests verify scoring mechanics with single tokens, so disable
// the min-match filter that exists to prevent false positives in production.
const UNIT_CONFIG = { ...DEFAULT_CONFIG, minMatchingTokens: 1 };

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    name: "test-skill",
    description: "A test skill.",
    path: "/skills/test-skill/SKILL.md",
    raw: "---\nname: test-skill\ndescription: A test skill.\n---\n",
    ...overrides,
  };
}

describe("scoreSkill", () => {
  test("returns 0 when no prompt tokens match the skill", () => {
    const skill = makeSkill({ name: "refactoring", description: "Improve code structure." });

    const score = scoreSkill("please help me with xyz unknown topic", skill, UNIT_CONFIG);

    expect(score).toBe(0);
  });

  test("name match contributes name weight per matching token", () => {
    // "refactor" in prompt; skill name "refactoring" stems to "refactor" → match
    const skill = makeSkill({ name: "refactoring", description: "Something unrelated." });

    const score = scoreSkill("refactor this class", skill, UNIT_CONFIG);

    // weight.name=3, one token match
    expect(score).toBe(3);
  });

  test("description-only match returns 0 (requires high-signal field)", () => {
    const skill = makeSkill({ name: "unrelated", description: "Terraform infrastructure deployment." });

    const score = scoreSkill("deploy terraform", skill, UNIT_CONFIG);

    // No name/tag match → description-only → 0
    expect(score).toBe(0);
  });

  test("description match contributes when name also matches", () => {
    const skill = makeSkill({ name: "terraform-infra", description: "Terraform infrastructure deployment." });

    const score = scoreSkill("terraform deploy", skill, UNIT_CONFIG);

    // "terraform" hits name (3) + description (1) = 4
    expect(score).toBe(4);
  });

  test("tags match contributes tags weight", () => {
    const skill = makeSkill({
      name: "unrelated",
      description: "Something.",
      tags: ["terraform", "infra"],
    });

    const score = scoreSkill("terraform plan", skill, UNIT_CONFIG);

    // weight.tags=2, one token match "terraform"
    expect(score).toBe(2);
  });

  test("multiple token matches across fields accumulate", () => {
    const skill = makeSkill({
      name: "kotlin-tdd",
      description: "TDD for kotlin code.",
      tags: ["tdd", "kotlin"],
    });

    const score = scoreSkill("kotlin tdd", skill, UNIT_CONFIG);

    // "kotlin": name(3) + tags(2) + description(1) = 6
    // "tdd": name(3) + tags(2) + description(1) = 6
    // total = 12
    expect(score).toBe(12);
  });

  test("suppressor tokens are excluded from scoring", () => {
    // "build" is in the suppressors list
    const skill = makeSkill({ name: "build", description: "Something." });

    const score = scoreSkill("build this project", skill, UNIT_CONFIG);

    // "build" is suppressed → contributes 0
    expect(score).toBe(0);
  });
});

describe("scoreSkill with corpus index", () => {
  test("rare token scores higher than common token for same field", () => {
    // "terraform" in 1/3 skills; "infra" in all 3 — both in name+description
    const skills = [
      makeSkill({ name: "terraform-infra", description: "Terraform manages infra." }),
      makeSkill({ name: "pulumi-infra", description: "Pulumi manages infra." }),
      makeSkill({ name: "ansible-infra", description: "Ansible manages infra." }),
    ];
    const index = buildCorpusIndex(skills);
    const skill = skills[0];

    const rareScore = scoreSkill("terraform", skill, UNIT_CONFIG, index);
    const commonScore = scoreSkill("infra", skill, UNIT_CONFIG, index);

    // With IDF, terraform (df=1) > infra (df=3) for same fields
    expect(rareScore).toBeGreaterThan(commonScore);
  });

  test("name field still outweighs description for same rare token", () => {
    const skills = [
      makeSkill({ name: "terraform-infra", description: "Something unrelated." }),
      makeSkill({ name: "other-skill", description: "Something else." }),
    ];
    const index = buildCorpusIndex(skills);

    const nameMatch = scoreSkill("terraform", skills[0], UNIT_CONFIG, index);
    const descMatch = scoreSkill("terraform", makeSkill({ name: "unrelated", description: "Use terraform for infra." }), UNIT_CONFIG, index);

    expect(nameMatch).toBeGreaterThan(descMatch);
  });

  test("without index falls back to fixed-weight behaviour", () => {
    const skill = makeSkill({ name: "refactoring", description: "Something unrelated." });

    const score = scoreSkill("refactor", skill, UNIT_CONFIG);

    expect(score).toBe(3); // name weight only, no IDF, single token → no normalisation effect
  });


});

describe("scoreStage2", () => {
  test("adds fractional score for prompt tokens found in skill body", () => {
    const body = Array(10).fill("terraform").join(" ");
    const skill = makeSkill({
      name: "infrastructure",
      description: "Manage infra.",
      raw: `---\nname: infrastructure\ndescription: Manage infra.\n---\n${body}`,
    });

    // "terraform" appears 10 times in body; capped at 5 → 5 * 0.4 = 2.0
    const bonus = scoreStage2("terraform plan", skill, DEFAULT_CONFIG);

    expect(bonus).toBeCloseTo(2.0);
  });

  test("caps body token hits at 5 regardless of frequency", () => {
    // 100 occurrences still capped at 5
    const body = Array(100).fill("snapshot").join(" ");
    const skill = makeSkill({
      name: "unrelated",
      description: "Completely different.",
      raw: `---\nname: unrelated\ndescription: Completely different.\n---\n${body}`,
    });

    const bonus = scoreStage2("snapshot", skill, DEFAULT_CONFIG);

    expect(bonus).toBeCloseTo(2.0); // min(100,5) * 0.4 = 2.0
  });

  test("returns 0 when no prompt tokens appear in body", () => {
    const skill = makeSkill({
      raw: "---\nname: test-skill\ndescription: A test skill.\n---\nCompletely unrelated content.",
    });

    const bonus = scoreStage2("kotlin coroutines", skill, DEFAULT_CONFIG);

    expect(bonus).toBe(0);
  });

  test("only scans up to stage2CharLimit of the body", () => {
    const limitedConfig = { ...DEFAULT_CONFIG, stage2CharLimit: 10 };
    const skill = makeSkill({
      raw: "---\nname: test-skill\ndescription: A test skill.\n---\n" +
           "unrelated_prefix ".repeat(5) + "terraform " + "other content",
    });

    // With a tiny limit that cuts off before "terraform", score should be 0
    const bonus = scoreStage2("terraform", skill, limitedConfig);

    expect(bonus).toBe(0);
  });
});
