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
}

export function createSessionContext(): SessionContext {
  return {
    tokens: new Map(),
    matchedSkills: new Set(),
    pinnedTokens: new Set(),
    messageCount: 0,
  };
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
 * Pins their name/tag tokens so they never decay.
 */
export function recordMatches(ctx: SessionContext, skillNames: string[], skillTokens?: string[]): void {
  for (const name of skillNames) {
    ctx.matchedSkills.add(name);
  }
  if (skillTokens) {
    for (const t of skillTokens) {
      ctx.pinnedTokens.add(t);
      // Also ensure pinned tokens are in the token map
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
