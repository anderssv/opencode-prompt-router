/**
 * Session context accumulator — tracks tokens and matched skills across
 * messages within a session to provide continuity for short follow-ups.
 */

export interface SessionEntry {
  count: number;
  lastSeen: number; // message index within session
}

export interface SessionContext {
  tokens: Map<string, SessionEntry>;
  matchedSkills: Set<string>;
  /** Tokens from matched skills that never decay */
  pinnedTokens: Set<string>;
  messageCount: number;
  /** Skills injected in the most recent user turn (cleared each new user message) */
  turnInjectedSkills: Set<string>;
  /** Hash of last assistant text scored by transform hook (avoid re-scoring) */
  lastScoredHash: string;
  /** messageCount at last injection (for cooldown) */
  lastInjectionAt: number;
  /** messageCount when each skill was last injected (for per-skill cooldown) */
  skillCooldowns: Map<string, number>;
}

const SKILL_COOLDOWN_MESSAGES = 5;

export function createSessionContext(): SessionContext {
  return {
    tokens: new Map(),
    matchedSkills: new Set(),
    pinnedTokens: new Set(),
    messageCount: 0,
    turnInjectedSkills: new Set(),
    lastScoredHash: "",
    lastInjectionAt: 0,
    skillCooldowns: new Map(),
  };
}

export function isSkillOnCooldown(ctx: SessionContext, skillName: string): boolean {
  const last = ctx.skillCooldowns.get(skillName);
  if (last === undefined) return false;
  return (ctx.messageCount - last) < SKILL_COOLDOWN_MESSAGES;
}

export function recordSkillInjected(ctx: SessionContext, skillName: string): void {
  ctx.skillCooldowns.set(skillName, ctx.messageCount);
}

/**
 * Record tokens from a new message into the session context.
 */
export function recordTokens(ctx: SessionContext, tokens: string[]): void {
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

/**
 * Record skills that were matched (and surfaced) in this session.
 * Does NOT pin tokens — pinning is reserved for AGENTS.md seeds only.
 */
export function recordMatches(ctx: SessionContext, skillNames: string[], skillTokens?: string[]): void {
  for (const name of skillNames) {
    ctx.matchedSkills.add(name);
  }
  // Record skill tokens into normal (decaying) session context only
  if (skillTokens) {
    for (const t of skillTokens) {
      if (!ctx.tokens.has(t)) {
        ctx.tokens.set(t, { count: 1, lastSeen: ctx.messageCount });
      }
    }
  }
}

/**
 * Get session tokens weighted by recency. Tokens from recent messages
 * get higher weight than old ones. Returns a map of token → weight (0..1).
 * Tokens from matched skills never decay (pinned).
 */
export function getSessionWeights(ctx: SessionContext, decay: number = 0.9): Map<string, number> {
  const weights = new Map<string, number>();
  if (ctx.messageCount === 0) return weights;

  // Collect pinned tokens from matched skills
  const pinnedTokens = ctx.pinnedTokens ?? new Set<string>();

  for (const [token, entry] of ctx.tokens) {
    if (pinnedTokens.has(token)) {
      // Pinned tokens always have max weight
      const freqBoost = Math.min(Math.sqrt(entry.count), 2);
      weights.set(token, freqBoost);
    } else {
      // Recency: how many messages ago was this last seen?
      const age = ctx.messageCount - entry.lastSeen;
      // Exponential decay: weight = decay^age, capped by frequency
      const recencyWeight = Math.pow(decay, age);
      // Frequency boost: sqrt of count, capped at 2
      const freqBoost = Math.min(Math.sqrt(entry.count), 2);
      weights.set(token, recencyWeight * freqBoost);
    }
  }

  return weights;
}
