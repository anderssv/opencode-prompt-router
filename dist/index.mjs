// @bun
// index.ts
import { homedir } from "os";
import { join as join2 } from "path";
import { access, readFile as readFile2 } from "fs/promises";
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
  const hits = [];
  let hasHighSignalMatch = false;
  const tokenCounts = new Map;
  for (const t of tokens) {
    const count = tokenCounts.get(t) ?? 0;
    if (count >= 2)
      continue;
    tokenCounts.set(t, count + 1);
    const idf = index ? index.idf(t) : 1;
    const inName = nameTokens.has(t);
    const inTags = tagTokens.has(t);
    const inDesc = descTokens.has(t);
    if (inName || inTags)
      hasHighSignalMatch = true;
    let tokenScore = 0;
    const fields = [];
    if (inName) {
      tokenScore += weights.name * idf;
      fields.push("name");
    }
    if (inTags) {
      tokenScore += weights.tags * idf;
      fields.push("tags");
    }
    if (inDesc) {
      tokenScore += weights.description * idf;
      fields.push("description");
    }
    if (tokenScore > 0)
      hits.push({ token: t, fields, idf, contribution: tokenScore });
  }
  if (!hasHighSignalMatch)
    return { score: 0, tokenHits: [] };
  const minTokens = config.minMatchingTokens ?? 1;
  const eligibleCount = new Set(tokens).size;
  if (eligibleCount >= 5 && hits.length < minTokens)
    return { score: 0, tokenHits: [] };
  hits.sort((a, b) => b.contribution - a.contribution);
  const topN = config.maxMatchingTokens ?? hits.length;
  let score = 0;
  for (let i = 0;i < Math.min(topN, hits.length); i++) {
    score += hits[i].contribution;
  }
  return { score, tokenHits: hits.slice(0, topN) };
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

// core/session.ts
function createSessionContext() {
  return {
    tokens: new Map,
    matchedSkills: new Set,
    pinnedTokens: new Set,
    messageCount: 0,
    turnInjectedSkills: new Set,
    lastScoredHash: "",
    lastInjectionAt: 0
  };
}
function recordTokens(ctx, tokens) {
  ctx.messageCount++;
  for (const t of tokens) {
    const existing = ctx.tokens.get(t);
    if (existing) {
      existing.count++;
      existing.lastSeen = ctx.messageCount;
    } else {
      ctx.tokens.set(t, { count: 1, lastSeen: ctx.messageCount });
    }
  }
}
function recordMatches(ctx, skillNames, skillTokens) {
  for (const name of skillNames) {
    ctx.matchedSkills.add(name);
  }
  if (skillTokens) {
    for (const t of skillTokens) {
      ctx.pinnedTokens.add(t);
      if (!ctx.tokens.has(t)) {
        ctx.tokens.set(t, { count: 1, lastSeen: ctx.messageCount });
      }
    }
  }
}
function getSessionWeights(ctx, decay = 0.9) {
  const weights = new Map;
  if (ctx.messageCount === 0)
    return weights;
  const pinnedTokens = ctx.pinnedTokens ?? new Set;
  for (const [token, entry] of ctx.tokens) {
    if (pinnedTokens.has(token)) {
      const freqBoost = Math.min(Math.sqrt(entry.count), 2);
      weights.set(token, freqBoost);
    } else {
      const age = ctx.messageCount - entry.lastSeen;
      const recencyWeight = Math.pow(decay, age);
      const freqBoost = Math.min(Math.sqrt(entry.count), 2);
      weights.set(token, recencyWeight * freqBoost);
    }
  }
  return weights;
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
var SESSION_AFFINITY_BONUS = 5;
function sessionBonus(skill, sessionWeights) {
  if (sessionWeights.size === 0)
    return 0;
  const nameTokens = new Set(tokenize(skill.name));
  const tagTokens = new Set(tokenize((skill.tags ?? []).join(" ")));
  for (const [token, weight] of sessionWeights) {
    if (weight < 0.3)
      continue;
    if (nameTokens.has(token) || tagTokens.has(token)) {
      return SESSION_AFFINITY_BONUS;
    }
  }
  return 0;
}
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
async function route(prompt, config, log, sessionCtx) {
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
  const sessionWeights = sessionCtx && sessionCtx.messageCount > 0 ? getSessionWeights(sessionCtx) : new Map;
  const scored = skills.map((skill) => {
    const result = scoreSkill(prompt, skill, config, index);
    const nearThreshold = result.score >= config.minScore && result.score <= config.minScore * STAGE2_WINDOW_FACTOR;
    const stage2Bonus = nearThreshold ? scoreStage2(prompt, skill, config, index) : 0;
    const sessBonus = sessionBonus(skill, sessionWeights);
    const totalScore = result.score + stage2Bonus + sessBonus;
    const breakdown = {
      tokenHits: result.tokenHits,
      stage1Score: result.score,
      stage2Bonus,
      sessionBonus: sessBonus,
      totalScore
    };
    return { skill, score: totalScore, breakdown };
  });
  const excludeSet = new Set(config.excludeSkills ?? []);
  const pinnedTokens = sessionCtx?.pinnedTokens ?? new Set;
  const hasSeedContext = pinnedTokens.size > 0;
  function passesGate(skill) {
    if (!hasSeedContext)
      return true;
    const nameTokens = tokenize(skill.name);
    const tagTokens = tokenize((skill.tags ?? []).join(" "));
    for (const t of [...nameTokens, ...tagTokens]) {
      if (pinnedTokens.has(t))
        return true;
    }
    return false;
  }
  const matches = scored.filter(({ skill, score }) => score >= config.minScore && !excludeSet.has(skill.name) && passesGate(skill)).sort((a, b) => b.score - a.score).slice(0, config.topN);
  const nearMisses = scored.filter(({ skill, score }) => score > 0 && score < config.minScore && !excludeSet.has(skill.name) && passesGate(skill)).sort((a, b) => b.score - a.score).slice(0, 3);
  const tookMs = Date.now() - start;
  const allNameTagTokens = new Set;
  for (const skill of skills) {
    for (const t of tokenize(skill.name))
      allNameTagTokens.add(t);
    for (const t of tokenize((skill.tags ?? []).join(" ")))
      allNameTagTokens.add(t);
  }
  const promptTokens = eligibleTokens(prompt, config, index);
  const corpusRelevantTokens = promptTokens.filter((t) => allNameTagTokens.has(t));
  if (config.debug) {
    const matchSummary = matches.map((m) => `${m.skill.name}(${m.score.toFixed(1)})`).join(", ") || "(none)";
    await log?.(`[prompt-router] matches: ${matchSummary} \u2014 ${tookMs}ms`);
  }
  return {
    matches,
    nearMisses,
    preamble: formatPreamble(matches),
    tookMs,
    corpusRelevantTokens,
    eligibleTokens: promptTokens
  };
}
async function extractProjectTokens(text, config) {
  const skills = await discoverSkills(config.skillPaths, globalCache);
  const index = cachedCorpusIndex(skills);
  const allNameTagTokens = new Set;
  for (const skill of skills) {
    for (const t of tokenize(skill.name))
      allNameTagTokens.add(t);
    for (const t of tokenize((skill.tags ?? []).join(" ")))
      allNameTagTokens.add(t);
  }
  const tokens = eligibleTokens(text, config, index);
  const relevant = [...new Set(tokens.filter((t) => allNameTagTokens.has(t)))];
  return relevant;
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
  "type",
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
  stage2CharLimit: 6000,
  excludeSkills: ["find-skills"]
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
  const sessions = new Map;
  const seededSessions = new Set;
  let lastSeenSessionID;
  const agentsMdPaths = [
    join2(directory, "AGENTS.md"),
    join2(directory, ".opencode", "AGENTS.md")
  ];
  const log = (msg) => client.app.log({ body: { service: "prompt-router", level: "info", message: msg } });
  return {
    "chat.message": async (input, output) => {
      try {
        const promptText = output.parts.filter((p) => p.type === "text").map((p) => ("text" in p) ? p.text : "").join(" ");
        if (!promptText.trim())
          return;
        if (promptText.length > maxPromptLength)
          return;
        const skillPaths = await resolveSkillPaths(directory);
        if (skillPaths.length === 0)
          return;
        const sessionID = input.sessionID;
        lastSeenSessionID = sessionID;
        if (!sessions.has(sessionID)) {
          sessions.set(sessionID, createSessionContext());
        }
        const sessionCtx = sessions.get(sessionID);
        const config = { ...DEFAULT_CONFIG, skillPaths, debug, minScore };
        if (!seededSessions.has(sessionID)) {
          seededSessions.add(sessionID);
          for (const agentsPath of agentsMdPaths) {
            try {
              const content = await readFile2(agentsPath, "utf-8");
              const projectTokens = await extractProjectTokens(content, config);
              const capped = projectTokens.slice(0, 20);
              if (capped.length > 0) {
                for (const t of capped) {
                  sessionCtx.pinnedTokens.add(t);
                  if (!sessionCtx.tokens.has(t)) {
                    sessionCtx.tokens.set(t, { count: 1, lastSeen: 0 });
                  }
                }
                if (debug) {
                  appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "seed", source: agentsPath, tokens: capped }) + `
`);
                }
              }
              break;
            } catch {}
          }
        }
        const result = await route(promptText, config, log, sessionCtx);
        sessionCtx.turnInjectedSkills.clear();
        recordTokens(sessionCtx, result.corpusRelevantTokens);
        if (result.matches.length > 0) {
          const skillTokens = result.matches.flatMap((m) => [
            ...tokenize(m.skill.name),
            ...tokenize((m.skill.tags ?? []).join(" "))
          ]);
          recordMatches(sessionCtx, result.matches.map((m) => m.skill.name), skillTokens);
          for (const m of result.matches) {
            sessionCtx.turnInjectedSkills.add(m.skill.name);
          }
          sessionCtx.lastInjectionAt = sessionCtx.messageCount;
        }
        if (debug) {
          const ts = new Date().toISOString();
          const sessionTokens = Object.fromEntries([...getSessionWeights(sessionCtx).entries()].filter(([, w]) => w >= 0.3).map(([t, w]) => [t, +w.toFixed(1)]));
          const formatScored = (m) => ({
            skill: m.skill.name,
            stage1: +m.breakdown.stage1Score.toFixed(1),
            stage2: +m.breakdown.stage2Bonus.toFixed(1),
            sessionBonus: m.breakdown.sessionBonus,
            total: +m.breakdown.totalScore.toFixed(1),
            hits: m.breakdown.tokenHits.map((h) => ({
              token: h.token,
              fields: h.fields,
              idf: +h.idf.toFixed(2),
              score: +h.contribution.toFixed(1)
            }))
          });
          const entry = {
            ts,
            action: result.preamble ? "inject" : "skip",
            prompt: promptText.replace(/\n/g, " "),
            eligible: result.eligibleTokens,
            session: sessionTokens,
            ms: result.tookMs
          };
          if (result.matches.length > 0) {
            entry.matches = result.matches.map(formatScored);
          }
          if (result.nearMisses.length > 0) {
            entry.nearMisses = result.nearMisses.map(formatScored);
          }
          appendFileSync(MATCH_LOG, JSON.stringify(entry) + `
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
      } catch (err) {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "error", hook: "chat.message", message: msg }) + `
`);
        } catch {}
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = output.messages;
        if (messages.length < 2)
          return;
        const sessionID = lastSeenSessionID;
        if (!sessionID)
          return;
        if (!sessions.has(sessionID))
          return;
        const sessionCtx = sessions.get(sessionID);
        let lastAssistantIdx = -1;
        for (let i = messages.length - 1;i >= 0; i--) {
          if (messages[i].info.role === "assistant") {
            lastAssistantIdx = i;
            break;
          }
        }
        if (lastAssistantIdx === -1)
          return;
        const assistantParts = messages[lastAssistantIdx].parts;
        const assistantText = assistantParts.filter((p) => p.type === "text").map((p) => ("text" in p) ? p.text : "").join(" ");
        if (!assistantText.trim())
          return;
        const textToScore = assistantText.slice(0, maxPromptLength);
        const textHash = textToScore.slice(0, 100);
        if (sessionCtx.lastScoredHash === textHash)
          return;
        sessionCtx.lastScoredHash = textHash;
        const skillPaths = await resolveSkillPaths(directory);
        if (skillPaths.length === 0)
          return;
        const transformMinScore = Math.round(minScore * 1.5);
        const config = { ...DEFAULT_CONFIG, skillPaths, debug: false, minScore: transformMinScore };
        const result = await route(textToScore, config, undefined, sessionCtx);
        if (!result.preamble)
          return;
        const newMatches = result.matches.filter((m) => !sessionCtx.turnInjectedSkills.has(m.skill.name));
        if (newMatches.length === 0)
          return;
        recordTokens(sessionCtx, result.corpusRelevantTokens);
        const skillTokens = newMatches.flatMap((m) => [
          ...tokenize(m.skill.name),
          ...tokenize((m.skill.tags ?? []).join(" "))
        ]);
        recordMatches(sessionCtx, newMatches.map((m) => m.skill.name), skillTokens);
        for (const m of newMatches) {
          sessionCtx.turnInjectedSkills.add(m.skill.name);
        }
        sessionCtx.lastInjectionAt = sessionCtx.messageCount;
        let lastUserIdx = -1;
        for (let i = messages.length - 1;i >= 0; i--) {
          if (messages[i].info.role === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx === -1)
          return;
        const userParts = messages[lastUserIdx].parts;
        const alreadyInjected = userParts.some((p) => p.type === "text" && ("text" in p) && p.text?.includes("Before responding, load these skills"));
        if (alreadyInjected)
          return;
        const names = newMatches.map(({ skill }) => skill.name).join(", ");
        const lines = newMatches.map(({ skill }) => {
          const desc = skill.description.slice(0, 120);
          return `- ${skill.name}: ${desc}`;
        });
        const preamble = `Before responding, load these skills using the skill tool: ${names}

${lines.join(`
`)}`;
        const preamblePart = {
          id: `prt_prompt-router-transform-${Date.now()}`,
          sessionID,
          messageID: "",
          type: "text",
          text: preamble + `

`,
          synthetic: true
        };
        messages[lastUserIdx].parts.push(preamblePart);
        if (debug) {
          const ts = new Date().toISOString();
          const entry = {
            ts,
            action: "inject-transform",
            assistantText: textToScore.replace(/\n/g, " ").slice(0, 200),
            matches: newMatches.map((m) => ({
              skill: m.skill.name,
              stage1: +m.breakdown.stage1Score.toFixed(1),
              stage2: +m.breakdown.stage2Bonus.toFixed(1),
              sessionBonus: m.breakdown.sessionBonus,
              total: +m.breakdown.totalScore.toFixed(1),
              hits: m.breakdown.tokenHits.map((h) => ({
                token: h.token,
                fields: h.fields,
                idf: +h.idf.toFixed(2),
                score: +h.contribution.toFixed(1)
              }))
            })),
            ms: result.tookMs
          };
          appendFileSync(MATCH_LOG, JSON.stringify(entry) + `
`);
        }
      } catch (err) {
        try {
          const msg = err instanceof Error ? err.message : String(err);
          appendFileSync(MATCH_LOG, JSON.stringify({ ts: new Date().toISOString(), action: "error", hook: "transform", message: msg }) + `
`);
        } catch {}
      }
    }
  };
};
var module = {
  id: "opencode-prompt-router",
  server: PromptRouter
};
export {
  module,
  PromptRouter
};
