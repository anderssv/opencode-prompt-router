import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { discoverSkills } from "../core/discovery";
import { SkillCache } from "../core/cache";

const FIXTURES = join(import.meta.dir, "fixtures/skills");

describe("discoverSkills", () => {
  test("returns empty array when paths list is empty", async () => {
    const cache = new SkillCache();

    const skills = await discoverSkills([], cache);

    expect(skills).toEqual([]);
  });

  test("returns empty array when directory has no SKILL.md files", async () => {
    const cache = new SkillCache();

    const skills = await discoverSkills(["/tmp"], cache);

    expect(skills).toEqual([]);
  });

  test("discovers all SKILL.md files in fixture directory", async () => {
    const cache = new SkillCache();

    const skills = await discoverSkills([FIXTURES], cache);

    expect(skills.length).toBe(14);
  });

  test("returns skills with correct name and description", async () => {
    const cache = new SkillCache();

    const skills = await discoverSkills([FIXTURES], cache);
    const refactoring = skills.find((s) => s.name === "refactoring");

    expect(refactoring).toBeDefined();
    expect(refactoring?.description).toContain("Refactoring process");
  });

  test("uses cache: skill object is identical on second call", async () => {
    const cache = new SkillCache();

    const first = await discoverSkills([FIXTURES], cache);
    const second = await discoverSkills([FIXTURES], cache);
    const firstRef = first.find((s) => s.name === "refactoring");
    const secondRef = second.find((s) => s.name === "refactoring");

    // Same object reference means cache was used
    expect(firstRef).toBe(secondRef);
  });

  test("skips files that fail to parse without throwing", async () => {
    const cache = new SkillCache();
    const skills = await discoverSkills([FIXTURES, "/nonexistent/path"], cache);

    expect(skills.length).toBe(14);
  });
});
