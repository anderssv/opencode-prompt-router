/**
 * False-positive regression tests using the approval test pattern.
 *
 * Each vague/conversational prompt is routed against the fixture corpus and
 * the full match output is compared to an .approved.txt snapshot. When
 * scoring changes, the diff shows exactly what shifted — no need to guess
 * which individual assertion broke.
 *
 * Workflow:
 *   1. Run tests → fails (no .approved file yet, or output changed)
 *   2. Review the .received.txt file
 *   3. If correct, copy .received.txt → .approved.txt
 *   4. Commit the .approved.txt file
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { route } from "../core/router";
import { DEFAULT_CONFIG } from "../core/config";

const FIXTURES = join(import.meta.dir, "fixtures/skills");
const CONFIG = { ...DEFAULT_CONFIG, skillPaths: [FIXTURES] };
const APPROVALS_DIR = join(import.meta.dir, "approvals");

beforeAll(async () => {
  await mkdir(APPROVALS_DIR, { recursive: true });
});

function formatResult(prompt: string, matches: { skill: { name: string }; score: number }[]): string {
  const lines = [
    `prompt: ${prompt}`,
    `matches (minScore=${CONFIG.minScore}):`,
  ];
  if (matches.length === 0) {
    lines.push("  (none)");
  } else {
    for (const m of matches) {
      lines.push(`  ${m.skill.name}: ${m.score.toFixed(2)}`);
    }
  }
  return lines.join("\n") + "\n";
}

async function verifyRoute(testName: string, prompt: string) {
  const result = await route(prompt, CONFIG);
  const received = formatResult(prompt, result.matches);

  const approvedPath = join(APPROVALS_DIR, `${testName}.approved.txt`);
  const receivedPath = join(APPROVALS_DIR, `${testName}.received.txt`);

  await writeFile(receivedPath, received);

  let approved: string;
  try {
    approved = await readFile(approvedPath, "utf8");
  } catch {
    throw new Error(
      `No approved file yet. Review and approve:\n` +
      `  cp "${receivedPath}" "${approvedPath}"\n\n` +
      `Received output:\n${received}`,
    );
  }

  expect(received).toBe(approved);
}

// --- Vague / conversational prompts that should match few or no skills ---

describe("false-positive approval tests", () => {
  test("vague prompt about skills and CLI", () =>
    verifyRoute(
      "vague-skills-cli",
      "Also add that building and distributing skills can be good. A well thought out CLI with raw data fallbacks is better.",
    ));

  test("general coding chat", () =>
    verifyRoute(
      "general-coding-chat",
      "I think we should focus on code quality and make sure everything works well before shipping.",
    ));

  test("project management talk", () =>
    verifyRoute(
      "project-management",
      "Let's schedule the sprint review for next week and make sure the team is aligned on priorities.",
    ));

  test("vague question about tools", () =>
    verifyRoute(
      "vague-tools",
      "What tools do you recommend for building modern web applications with good developer experience?",
    ));

  test("casual greeting", () =>
    verifyRoute(
      "casual-greeting",
      "Hey, how are you doing today? Can you help me with something?",
    ));

  test("discussion about architecture", () =>
    verifyRoute(
      "architecture-discussion",
      "I've been thinking about whether we should go with microservices or a monolith. What are the trade-offs?",
    ));

  test("vague debugging request", () =>
    verifyRoute(
      "vague-debugging",
      "Something is broken in production. The users are complaining about slow performance and errors.",
    ));

  test("documentation discussion", () =>
    verifyRoute(
      "documentation-discussion",
      "We need to improve our documentation. It's hard for new developers to onboard and understand the system.",
    ));

  test("deployment chat", () =>
    verifyRoute(
      "deployment-chat",
      "Can we set up automatic deployments to staging when we merge to the main branch?",
    ));

  test("meeting notes style prompt", () =>
    verifyRoute(
      "meeting-notes",
      "Action items from today: update the API, fix the login bug, and add monitoring for the new service.",
    ));
});
