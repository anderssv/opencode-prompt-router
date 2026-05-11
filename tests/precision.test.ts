/**
 * Precision regression tests against the fixture skills corpus.
 *
 * Each entry asserts that the expected skill appears somewhere in the top-3
 * results for the given prompt. Failures here indicate a scoring regression,
 * not necessarily broken code — they should trigger tuning of weights,
 * suppressors, or scoring config before the fix is committed.
 */
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { route } from "../core/router";
import { DEFAULT_CONFIG } from "../core/config";

const FIXTURES = join(import.meta.dir, "fixtures/skills");
const CONFIG = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES], topN: 3, minScore: 1 };

function precisionTest(prompt: string, expectedSkill: string) {
  test(`"${prompt.slice(0, 50)}" → top-3 includes ${expectedSkill}`, async () => {
    const result = await route(prompt, CONFIG);
    const names = result.matches.map((m) => m.skill.name);

    expect(names).toContain(expectedSkill);
  });
}

describe("precision: top-3 routing against fixture corpus", () => {
  precisionTest("refactor this messy class", "refactoring");
  precisionTest("write kotlin tests with fakes", "kotlin-tdd");
  precisionTest("deep review of access control authentication authorization patterns", "access-control-review");
  precisionTest("create a presentation about event sourcing", "presentation-brief");
  precisionTest("help me write a bash script", "writing-bash-scripts");
  precisionTest("use TDD to add a new feature", "tdd");
  precisionTest("threat model this new API endpoint", "threat-modeling");
  precisionTest("I want to design a new feature collaboratively", "collaborative-design");
  precisionTest("review this kotlin code for idiomatic style", "idiomatic-kotlin");
  precisionTest("teach me about hexagonal architecture", "hexagonal-architecture");
  precisionTest("query application insights for errors", "appinsights-query");
  precisionTest("wire up dependencies without a DI framework in kotlin", "kotlin-context-di");
});

function falsePositiveTest(prompt: string, unwantedSkill: string) {
  test(`"${prompt.slice(0, 50)}" → should NOT include ${unwantedSkill}`, async () => {
    const result = await route(prompt, { ...CONFIG, minScore: DEFAULT_CONFIG.minScore });
    const names = result.matches.map((m) => m.skill.name);

    expect(names).not.toContain(unwantedSkill);
  });
}

describe("precision: false-positive guards against fixture corpus", () => {
  falsePositiveTest(
    "Also add that building and distributing skills can be good. A well thought out CLI with raw data fallbacks is better.",
    "appinsights-query",
  );
  falsePositiveTest(
    "Also add that building and distributing skills can be good. A well thought out CLI with raw data fallbacks is better.",
    "playwright-cli",
  );
});
