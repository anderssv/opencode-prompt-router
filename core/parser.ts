import type { Skill } from "./types";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/**
 * Extract a scalar field from a YAML frontmatter string.
 * Handles inline values and folded/literal block scalars (> and |).
 * Does NOT handle multi-document YAML, anchors, or other advanced features —
 * SKILL.md frontmatter uses a small, predictable subset of YAML.
 */
function extractField(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split("\n");
  const keyPrefix = `${key}:`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(keyPrefix)) continue;

    const rest = line.slice(keyPrefix.length).trim();

    // Folded (>) or literal (|) block scalar: value spans the following indented lines
    if (rest === ">" || rest === "|") {
      const continuationLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(/^\s+\S/)) {
          continuationLines.push(lines[j].trim());
        } else {
          break;
        }
      }
      return continuationLines.join(" ").trim();
    }

    return rest;
  }

  return undefined;
}

function extractInlineArray(frontmatter: string, key: string): string[] | undefined {
  const raw = extractField(frontmatter, key);
  if (!raw) return undefined;
  const inline = raw.match(/^\[(.*)\]$/);
  if (!inline) return undefined;
  return inline[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseSkill(content: string, path: string): Skill {
  const fmMatch = content.match(FRONTMATTER_RE);
  if (!fmMatch) {
    throw new Error(`Missing YAML frontmatter in ${path}`);
  }
  const frontmatter = fmMatch[1];

  const name = extractField(frontmatter, "name");
  if (!name) {
    throw new Error(`Missing 'name' field in frontmatter of ${path}`);
  }

  const description = extractField(frontmatter, "description");
  if (!description) {
    throw new Error(`Missing 'description' field in frontmatter of ${path}`);
  }

  return {
    name,
    description,
    path,
    raw: content,
    tags: extractInlineArray(frontmatter, "tags"),
  };
}
