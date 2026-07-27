import { describe, it, expect } from "bun:test";
import { createSessionContext, recordTokens, recordMatches, getSessionWeights, isSkillOnCooldown, recordSkillInjected } from "../core/session";

describe("session context", () => {
  it("starts empty", () => {
    const ctx = createSessionContext();
    expect(ctx.messageCount).toBe(0);
    expect(ctx.tokens.size).toBe(0);
    expect(ctx.matchedSkills.size).toBe(0);
  });

  it("records tokens with count and lastSeen", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin", "tdd", "fake"]);
    expect(ctx.messageCount).toBe(1);
    expect(ctx.tokens.get("kotlin")).toEqual({ count: 1, lastSeen: 1 });

    recordTokens(ctx, ["kotlin", "test"]);
    expect(ctx.messageCount).toBe(2);
    expect(ctx.tokens.get("kotlin")).toEqual({ count: 2, lastSeen: 2 });
    expect(ctx.tokens.get("tdd")).toEqual({ count: 1, lastSeen: 1 });
    expect(ctx.tokens.get("test")).toEqual({ count: 1, lastSeen: 2 });
  });

  it("records matched skills", () => {
    const ctx = createSessionContext();
    recordMatches(ctx, ["kotlin-tdd", "hexagonal-architecture"]);
    expect(ctx.matchedSkills.has("kotlin-tdd")).toBe(true);
    expect(ctx.matchedSkills.has("hexagonal-architecture")).toBe(true);
  });

  it("applies recency decay to session weights", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin", "tdd"]);
    recordTokens(ctx, ["refactor"]);
    recordTokens(ctx, ["deploy"]);

    const weights = getSessionWeights(ctx, 0.7);
    // "deploy" is most recent (age=0), weight = 0.7^0 * sqrt(1) = 1.0
    expect(weights.get("deploy")).toBeCloseTo(1.0);
    // "refactor" is age=1, weight = 0.7^1 * sqrt(1) = 0.7
    expect(weights.get("refactor")).toBeCloseTo(0.7);
    // "kotlin" is age=2, weight = 0.7^2 * sqrt(1) = 0.49
    expect(weights.get("kotlin")).toBeCloseTo(0.49);
  });

  it("boosts frequently seen tokens", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    recordTokens(ctx, ["kotlin"]);
    recordTokens(ctx, ["kotlin"]);

    const weights = getSessionWeights(ctx, 0.7);
    // "kotlin" seen 3 times, last at message 3 (age=0)
    // weight = 0.7^0 * sqrt(3) = 1.732
    expect(weights.get("kotlin")).toBeCloseTo(Math.sqrt(3));
  });

  it("getSessionWeights returns empty map for fresh context", () => {
    const ctx = createSessionContext();
    expect(getSessionWeights(ctx).size).toBe(0);
  });

  it("matched skill tokens decay normally (not pinned)", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    recordMatches(ctx, ["kotlin-tdd"], ["kotlin", "tdd"]);

    // Advance many messages without mentioning kotlin/tdd
    recordTokens(ctx, ["deploy"]);
    recordTokens(ctx, ["deploy"]);
    recordTokens(ctx, ["deploy"]);
    recordTokens(ctx, ["deploy"]);
    recordTokens(ctx, ["deploy"]);

    const weights = getSessionWeights(ctx, 0.9);
    // "kotlin" and "tdd" should decay — not pinned
    expect(weights.get("kotlin")!).toBeLessThan(1.0);
    // "deploy" is recent, should have high weight
    expect(weights.get("deploy")!).toBeGreaterThan(0.3);
  });

  it("uses 0.9 decay by default — tokens last longer", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    // 7 messages later
    for (let i = 0; i < 7; i++) recordTokens(ctx, ["other"]);

    const weights = getSessionWeights(ctx); // default 0.9
    // 0.9^7 = 0.478 — still above 0.3 threshold
    expect(weights.get("kotlin")!).toBeGreaterThan(0.3);
  });
});

describe("skill cooldown", () => {
  it("skill is on cooldown immediately after injection", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    recordSkillInjected(ctx, "kotlin-tdd");
    expect(isSkillOnCooldown(ctx, "kotlin-tdd")).toBe(true);
  });

  it("skill comes off cooldown after 5 messages", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    recordSkillInjected(ctx, "kotlin-tdd");
    // Advance 5 messages
    for (let i = 0; i < 5; i++) recordTokens(ctx, ["other"]);
    expect(isSkillOnCooldown(ctx, "kotlin-tdd")).toBe(false);
  });

  it("skill still on cooldown after 4 messages", () => {
    const ctx = createSessionContext();
    recordTokens(ctx, ["kotlin"]);
    recordSkillInjected(ctx, "kotlin-tdd");
    for (let i = 0; i < 4; i++) recordTokens(ctx, ["other"]);
    expect(isSkillOnCooldown(ctx, "kotlin-tdd")).toBe(true);
  });

  it("uninjected skill is never on cooldown", () => {
    const ctx = createSessionContext();
    expect(isSkillOnCooldown(ctx, "kotlin-tdd")).toBe(false);
  });
});
