import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { route } from "../core/router";
import { DEFAULT_CONFIG } from "../core/config";

const FIXTURES = join(import.meta.dir, "fixtures/skills");

describe("route", () => {
  test("returns empty matches and empty preamble when no skills are found", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: ["/nonexistent"] };

    const result = await route("refactor my code", config);

    expect(result.matches).toEqual([]);
    expect(result.preamble).toBe("");
  });

  test("returns matches sorted by score descending", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], minScore: 1 };

    // "refactoring" should outscore "kotlin-tdd" for this prompt
    const result = await route("refactor this module", config);

    expect(result.matches.length).toBeGreaterThan(0);
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1].score).toBeGreaterThanOrEqual(result.matches[i].score);
    }
  });

  test("filters out skills below minScore", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], minScore: 999 };

    const result = await route("refactor this module", config);

    expect(result.matches).toEqual([]);
  });

  test("limits results to topN", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], topN: 1, minScore: 1 };

    const result = await route("refactor this module", config);

    expect(result.matches.length).toBeLessThanOrEqual(1);
  });

  test("preamble lists skill names and descriptions", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], minScore: 1, topN: 3 };

    const result = await route("refactor this module", config);

    expect(result.preamble).toContain("load these skills using the skill tool");
    for (const { skill } of result.matches) {
      expect(result.preamble).toContain(skill.name);
    }
  });

  test("preamble is empty string when no matches pass minScore", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], minScore: 999 };

    const result = await route("refactor this module", config);

    expect(result.preamble).toBe("");
  });

  test("tookMs is a non-negative number", async () => {
    const config = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES] };

    const result = await route("refactor this module", config);

    expect(result.tookMs).toBeGreaterThanOrEqual(0);
  });
});
