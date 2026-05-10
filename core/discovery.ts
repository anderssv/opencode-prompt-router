import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Skill } from "./types";
import type { SkillCache } from "./cache";
import { parseSkill } from "./parser";

async function findSkillFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSkillFiles(fullPath)));
    } else if (entry.name === "SKILL.md") {
      results.push(fullPath);
    }
  }
  return results;
}

export async function discoverSkills(paths: string[], cache: SkillCache): Promise<Skill[]> {
  const skills: Skill[] = [];

  for (const basePath of paths) {
    const files = await findSkillFiles(basePath);

    for (const filePath of files) {
      let mtime: number;
      try {
        const stats = await stat(filePath);
        mtime = stats.mtimeMs;
      } catch {
        continue;
      }

      const cached = cache.get(filePath, mtime);
      if (cached) {
        skills.push(cached);
        continue;
      }

      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }

      let skill: Skill;
      try {
        skill = parseSkill(content, filePath);
      } catch {
        // Skip unparseable files silently — a bad SKILL.md shouldn't crash discovery
        continue;
      }

      cache.set(filePath, mtime, skill);
      skills.push(skill);
    }
  }

  return skills;
}
