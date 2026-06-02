// @bun
// index.ts
import { homedir } from "os";
import { join as join2 } from "path";
import { access } from "fs/promises";
import { appendFileSync } from "fs";

// core/cache.ts
class SkillCache {
  store = new Map;
  get(path, mtime) {
    const entry = this.store.get(path);
    if (!entry || entry.mtime !== mtime)
      return;
    return entry.skill;
  }
  set(path, mtime, skill) {
    this.store.set(path, { mtime, skill });
  }
}

// core/discovery.ts
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

// core/parser.ts
var FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
function extractField(frontmatter, key) {
  const lines = frontmatter.split(`
`);
  const keyPrefix = `${key}:`;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith(keyPrefix))
      continue;
    const rest = line.slice(keyPrefix.length).trim();
    if (rest === ">" || rest === "|") {
      const continuationLines = [];
      for (let j = i + 1;j < lines.length; j++) {
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
  return;
}
function extractInlineArray(frontmatter, key) {
  const raw = extractField(frontmatter, key);
  if (!raw)
    return;
  const inline = raw.match(/^\[(.*)\]$/);
  if (!inline)
    return;
  return inline[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}
function parseSkill(content, path) {
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
    tags: extractInlineArray(frontmatter, "tags")
  };
}

// core/discovery.ts
async function findSkillFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...await findSkillFiles(fullPath));
    } else if (entry.name === "SKILL.md") {
      results.push(fullPath);
    }
  }
  return results;
}
async function discoverSkills(paths, cache) {
  const skills = [];
  for (const basePath of paths) {
    const files = await findSkillFiles(basePath);
    for (const filePath of files) {
      let mtime;
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
      let content;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      let skill;
      try {
        skill = parseSkill(content, filePath);
      } catch {
        continue;
      }
      cache.set(filePath, mtime, skill);
      skills.push(skill);
    }
  }
  return skills;
}

// core/tokenizer.ts
var NO_STRIP_S_PRECEDING = new Set(["s", "x"]);
var STEM_SUFFIXES = ["ing", "ed", "s"];
var MIN_TOKEN_LENGTH = 3;
var MIN_STEM_LENGTH = 3;
function stem(token) {
  for (const suffix of STEM_SUFFIXES) {
    if (!token.endsWith(suffix))
      continue;
    const stemmed = token.slice(0, -suffix.length);
    if (stemmed.length < MIN_STEM_LENGTH)
      continue;
    if (suffix === "s" && NO_STRIP_S_PRECEDING.has(stemmed[stemmed.length - 1]))
      continue;
    return stemmed;
  }
  return token;
}
function tokenize(input) {
  return input.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= MIN_TOKEN_LENGTH).map(stem);
}

// core/scorer.ts
function fieldTokenSet(text) {
  return new Set(tokenize(text));
}
function eligibleTokens(prompt, config, index) {
  const suppressorSet = new Set(config.suppressors);
  return tokenize(prompt).filter((t) => {
    if (index && index.size >= 10 && index.idf(t) < config.idfFloor)
      return false;
    if (suppressorSet.has(t))
      return false;
    return true;
  });
}
var STAGE2_HIT_CAP = 5;
var STAGE2_HIT_WEIGHT = 0.4;
function scoreStage2(prompt, skill, config, index) {
  const eligible = new Set(eligibleTokens(prompt, config, index));
  const body = skill.raw.slice(0, config.stage2CharLimit);
  const bodyTokens = tokenize(body);
  const tokenCounts = new Map;
  for (const t of bodyTokens) {
    if (eligible.has(t)) {
      tokenCounts.set(t, (tokenCounts.get(t) ?? 0) + 1);
    }
  }
  let bonus = 0;
  for (const count of tokenCounts.values()) {
    bonus += Math.min(count, STAGE2_HIT_CAP) * STAGE2_HIT_WEIGHT;
  }
  return bonus;
}
function scoreSkill(prompt, skill, config, index) {
  const { weights } = config;
  const tokens = eligibleTokens(prompt, config, index);
  const nameTokens = fieldTokenSet(skill.name);
  const descTokens = fieldTokenSet(skill.description);
  const tagTokens = fieldTokenSet((skill.tags ?? []).join(" "));
  const contributions = [];
  let hasHighSignalMatch = false;
  for (const t of tokens) {
    const idf = index ? index.idf(t) : 1;
    const inName = nameTokens.has(t);
    const inTags = tagTokens.has(t);
    const inDesc = descTokens.has(t);
    if (inName || inTags)
      hasHighSignalMatch = true;
    let tokenScore = 0;
    if (inName)
      tokenScore += weights.name * idf;
    if (inTags)
      tokenScore += weights.tags * idf;
    if (inDesc)
      tokenScore += weights.description * idf;
    if (tokenScore > 0)
      contributions.push(tokenScore);
  }
  if (!hasHighSignalMatch)
    return 0;
  const minTokens = config.minMatchingTokens ?? 1;
  const eligibleCount = new Set(tokens).size;
  if (eligibleCount >= 5 && contributions.length < minTokens)
    return 0;
  contributions.sort((a, b) => b - a);
  const topN = config.maxMatchingTokens ?? contributions.length;
  let score = 0;
  for (let i = 0;i < Math.min(topN, contributions.length); i++) {
    score += contributions[i];
  }
  return score;
}

// core/corpus.ts
function skillTokenSet(skill) {
  return new Set([
    ...tokenize(skill.name),
    ...tokenize(skill.description),
    ...tokenize((skill.tags ?? []).join(" "))
  ]);
}
function buildCorpusIndex(skills) {
  const N = skills.length;
  const df = new Map;
  for (const skill of skills) {
    for (const token of skillTokenSet(skill)) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  return {
    size: N,
    idf(token) {
      const docFreq = df.get(token) ?? 1;
      return Math.log(N / docFreq);
    }
  };
}

// core/enrich.ts
var MAX_DERIVED_TAGS = 8;
var MIN_BODY_TOKENS = 10;
function deriveTags(skill, allSkills) {
  const bodyTokens = tokenize(skill.raw);
  if (bodyTokens.length < MIN_BODY_TOKENS)
    return [];
  const identityTokens = new Set([
    ...tokenize(skill.name),
    ...tokenize(skill.description)
  ]);
  const localFreq = new Map;
  for (const t of bodyTokens) {
    if (identityTokens.has(t))
      continue;
    if (t.length < 3)
      continue;
    localFreq.set(t, (localFreq.get(t) ?? 0) + 1);
  }
  const globalDf = new Map;
  for (const other of allSkills) {
    if (other.path === skill.path)
      continue;
    const otherTokens = new Set(tokenize(other.raw));
    for (const t of otherTokens) {
      globalDf.set(t, (globalDf.get(t) ?? 0) + 1);
    }
  }
  const candidates = [];
  for (const [token, freq] of localFreq) {
    const df = globalDf.get(token) ?? 0;
    const score = freq / (df + 1);
    if (score > 0.5) {
      candidates.push({ token, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_DERIVED_TAGS).map((c) => c.token);
}

// core/router.ts
var globalCache = new SkillCache;
var cachedCorpus;
function cachedCorpusIndex(skills) {
  const key = skills.map((s) => s.path).sort().join("|");
  if (cachedCorpus?.key === key)
    return cachedCorpus.index;
  const index = buildCorpusIndex(skills);
  cachedCorpus = { key, index };
  return index;
}
var PREAMBLE_DESC_LIMIT = 120;
var STAGE2_WINDOW_FACTOR = 3;
function formatPreamble(matches) {
  if (matches.length === 0)
    return "";
  const names = matches.map(({ skill }) => skill.name).join(", ");
  const lines = matches.map(({ skill }) => {
    const desc = skill.description.slice(0, PREAMBLE_DESC_LIMIT);
    return `- ${skill.name}: ${desc}`;
  });
  return `Before responding, load these skills using the skill tool: ${names}

${lines.join(`
`)}`;
}
async function route(prompt, config, log) {
  const start = Date.now();
  const skills = await discoverSkills(config.skillPaths, globalCache);
  if (config.debug) {
    await log?.(`[prompt-router] prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? "\u2026" : ""}"`);
    await log?.(`[prompt-router] discovered ${skills.length} skills`);
  }
  const index = cachedCorpusIndex(skills);
  for (const skill of skills) {
    if (!skill.tags || skill.tags.length === 0) {
      skill.tags = deriveTags(skill, skills);
    }
  }
  const scored = skills.map((skill) => {
    const score = scoreSkill(prompt, skill, config, index);
    const nearThreshold = score >= config.minScore && score <= config.minScore * STAGE2_WINDOW_FACTOR;
    const bonus = nearThreshold ? scoreStage2(prompt, skill, config, index) : 0;
    return { skill, score: score + bonus };
  });
  const matches = scored.filter(({ score }) => score >= config.minScore).sort((a, b) => b.score - a.score).slice(0, config.topN);
  const tookMs = Date.now() - start;
  if (config.debug) {
    const matchSummary = matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
    await log?.(`[prompt-router] matches: ${matchSummary} \u2014 ${tookMs}ms`);
  }
  return {
    matches,
    preamble: formatPreamble(matches),
    tookMs
  };
}

// core/config.ts
var SUPPRESSORS = [
  "skill",
  "help",
  "build",
  "make",
  "add",
  "find",
  "search",
  "look",
  "read",
  "return",
  "check",
  "show",
  "run",
  "set",
  "get",
  "use",
  "update",
  "create",
  "give",
  "open",
  "event",
  "events",
  "file",
  "files",
  "directory",
  "path",
  "test",
  "tests",
  "config",
  "configuration",
  "project",
  "repo",
  "repository",
  "git",
  "branch",
  "sha",
  "url",
  "link",
  "api",
  "session",
  "service",
  "good",
  "better",
  "well",
  "new",
  "you",
  "are",
  "the",
  "any",
  "they",
  "its",
  "that",
  "this",
  "also",
  "can",
  "not",
  "how",
  "too",
  "out",
  "off",
  "has",
  "was",
  "been",
  "just",
  "want",
  "some",
  "very",
  "than"
];
var DEFAULT_CONFIG = {
  skillPaths: [],
  topN: 3,
  minScore: 15,
  weights: {
    name: 3,
    tags: 2,
    description: 1
  },
  suppressors: SUPPRESSORS,
  idfFloor: 1.5,
  maxMatchingTokens: 4,
  minMatchingTokens: 2,
  stage2CharLimit: 6000
};

// index.ts
var MATCH_LOG = join2(homedir(), "prompt-router.log");
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
async function resolveSkillPaths(directory) {
  const candidates = [
    join2(homedir(), ".agents", "skills"),
    join2(homedir(), ".claude", "skills"),
    join2(directory, ".opencode", "skills")
  ];
  const found = [];
  for (const p of candidates) {
    if (await exists(p))
      found.push(p);
  }
  return found;
}
var PromptRouter = async ({ directory, client }, options) => {
  const opts = options ?? {};
  const minScore = opts.minScore ?? DEFAULT_CONFIG.minScore;
  const maxPromptLength = opts.maxPromptLength ?? 500;
  const debug = opts.debug ?? !!process.env.PROMPT_ROUTER_DEBUG;
  const log = (msg) => client.app.log({ body: { service: "prompt-router", level: "info", message: msg } });
  return {
    "chat.message": async (input, output) => {
      const promptText = output.parts.filter((p) => p.type === "text").map((p) => ("text" in p) ? p.text : "").join(" ");
      if (!promptText.trim())
        return;
      if (promptText.length > maxPromptLength)
        return;
      const skillPaths = await resolveSkillPaths(directory);
      if (skillPaths.length === 0)
        return;
      const config = { ...DEFAULT_CONFIG, skillPaths, debug, minScore };
      const result = await route(promptText, config, log);
      if (debug) {
        const matches = result.matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
        const prompt = promptText.replace(/\n/g, " ");
        appendFileSync(MATCH_LOG, `${new Date().toISOString()}  ${prompt}  \u2192  ${matches}  (${result.tookMs}ms)
`);
      }
      if (!result.preamble)
        return;
      const preamblePart = {
        id: `prt_prompt-router-${Date.now()}`,
        sessionID: input.sessionID,
        messageID: input.messageID ?? "",
        type: "text",
        text: result.preamble + `

`,
        synthetic: !config.debug
      };
      output.parts.push(preamblePart);
    }
  };
};
export {
  PromptRouter
};
