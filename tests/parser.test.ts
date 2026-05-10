import { describe, test, expect } from "bun:test";
import { parseSkill } from "../core/parser";

const minimalFrontmatter = `---
name: refactoring
description: Refactoring process. Invoke immediately when user mentions refactoring.
---

# Body content here
`;

describe("parseSkill", () => {
  test("parses name and description from YAML frontmatter", () => {
    const skill = parseSkill(minimalFrontmatter, "/skills/refactoring/SKILL.md");

    expect(skill.name).toBe("refactoring");
    expect(skill.description).toBe(
      "Refactoring process. Invoke immediately when user mentions refactoring.",
    );
  });

  test("returns path and raw content unchanged", () => {
    const skill = parseSkill(minimalFrontmatter, "/some/path/SKILL.md");

    expect(skill.path).toBe("/some/path/SKILL.md");
    expect(skill.raw).toBe(minimalFrontmatter);
  });

  test("throws when frontmatter is missing", () => {
    const content = "# Just a heading, no frontmatter\n";

    expect(() => parseSkill(content, "/p/SKILL.md")).toThrow(/frontmatter/i);
  });

  test("throws when name is missing", () => {
    const content = `---
description: Has a description but no name.
---
`;

    expect(() => parseSkill(content, "/p/SKILL.md")).toThrow(/name/i);
  });

  test("throws when description is missing", () => {
    const content = `---
name: nodescription
---
`;

    expect(() => parseSkill(content, "/p/SKILL.md")).toThrow(/description/i);
  });

  test("tags are undefined when absent", () => {
    const skill = parseSkill(minimalFrontmatter, "/p/SKILL.md");

    expect(skill.tags).toBeUndefined();
  });

  test("parses optional tags as inline array", () => {
    const content = `---
name: refactor
description: Refactor process.
tags: [refactor, cleanup, design]
---
`;

    const skill = parseSkill(content, "/p/SKILL.md");

    expect(skill.tags).toEqual(["refactor", "cleanup", "design"]);
  });

  test("parses folded multi-line description", () => {
    const content = `---
name: teachme
description: >
  Transform any topic into a presentation.
  Use when users want to learn visually.
---
`;

    const skill = parseSkill(content, "/p/SKILL.md");

    expect(skill.description).toBe(
      "Transform any topic into a presentation. Use when users want to learn visually.",
    );
  });
});
