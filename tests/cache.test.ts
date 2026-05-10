import { describe, test, expect } from "bun:test";
import { SkillCache } from "../core/cache";
import type { Skill } from "../core/types";

function makeSkill(name: string): Skill {
  return {
    name,
    description: "A skill.",
    path: `/skills/${name}/SKILL.md`,
    raw: `---\nname: ${name}\ndescription: A skill.\n---\n`,
  };
}

describe("SkillCache", () => {
  test("get returns undefined for unknown path", () => {
    const cache = new SkillCache();

    const result = cache.get("/unknown/SKILL.md", 1000);

    expect(result).toBeUndefined();
  });

  test("get returns undefined when mtime differs (stale entry)", () => {
    const cache = new SkillCache();
    const skill = makeSkill("refactoring");

    cache.set(skill.path, 1000, skill);
    const result = cache.get(skill.path, 9999);

    expect(result).toBeUndefined();
  });

  test("get returns skill on path and mtime match", () => {
    const cache = new SkillCache();
    const skill = makeSkill("refactoring");

    cache.set(skill.path, 1000, skill);
    const result = cache.get(skill.path, 1000);

    expect(result).toBe(skill);
  });

  test("set overwrites previous entry for the same path", () => {
    const cache = new SkillCache();
    const v1 = makeSkill("refactoring");
    const v2 = { ...makeSkill("refactoring"), description: "Updated." };

    cache.set(v1.path, 1000, v1);
    cache.set(v1.path, 2000, v2);
    const result = cache.get(v1.path, 2000);

    expect(result?.description).toBe("Updated.");
  });
});
