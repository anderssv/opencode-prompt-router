import { describe, test, expect } from "bun:test";
import { deriveTags } from "../core/enrich";
import type { Skill } from "../core/types";

function makeSkill(overrides: Partial<Skill>): Skill {
  return {
    name: "test-skill",
    description: "A test skill.",
    path: "/skills/test-skill/SKILL.md",
    raw: "---\nname: test-skill\ndescription: A test skill.\n---\nSome body content.",
    ...overrides,
  };
}

describe("deriveTags", () => {
  test("returns empty array when body is too short", () => {
    const skill = makeSkill({
      raw: "---\nname: test\ndescription: test.\n---\nShort.",
    });
    const allSkills = [skill];

    const tags = deriveTags(skill, allSkills);

    expect(tags).toEqual([]);
  });

  test("extracts tokens unique to this skill's body", () => {
    const skillA = makeSkill({
      name: "infra-tool",
      raw: "---\nname: infra-tool\ndescription: Manage infra.\n---\nTerraform modules and providers. HCL syntax and state management. Remote backends.",
    });
    const skillB = makeSkill({
      name: "other-skill",
      raw: "---\nname: other-skill\ndescription: Something else.\n---\nKotlin coroutines and suspend functions. Flow builders.",
    });

    const tags = deriveTags(skillA, [skillA, skillB]);

    expect(tags).toContain("terraform");
    expect(tags).toContain("hcl");
  });

  test("does not include tokens already in name or description", () => {
    const skill = makeSkill({
      name: "terraform-infra",
      description: "Manage infrastructure with Terraform.",
      raw: "---\nname: terraform-infra\ndescription: Manage infrastructure.\n---\nTerraform modules. HCL syntax. Remote state backends. Provider configuration.",
    });

    const tags = deriveTags(skill, [skill]);

    // "terraform" and "infra" are already in name — don't duplicate
    expect(tags).not.toContain("terraform");
    expect(tags).not.toContain("infra");
    // But body-unique tokens should appear
    expect(tags).toContain("hcl");
  });

  test("limits number of derived tags", () => {
    const body = "word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 " +
      "word11 word12 word13 word14 word15 word16 word17 word18 word19 word20";
    const skill = makeSkill({
      raw: `---\nname: test\ndescription: test.\n---\n${body}`,
    });

    const tags = deriveTags(skill, [skill]);

    expect(tags.length).toBeLessThanOrEqual(8);
  });

  test("does not override explicit frontmatter tags", () => {
    const skill = makeSkill({
      tags: ["existing-tag"],
      raw: "---\nname: test\ndescription: test.\ntags: [existing-tag]\n---\nTerraform HCL modules providers backends.",
    });

    const tags = deriveTags(skill, [skill]);

    // Function returns derived tags regardless — caller merges/skips
    expect(tags.length).toBeGreaterThan(0);
  });
});
