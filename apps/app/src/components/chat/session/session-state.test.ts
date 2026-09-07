import { describe, it, expect } from "vitest";
import {
  applySessionPatch,
  computeSessionLocks,
  decodeSessionState,
  defaultChatSessionState,
  encodeSessionState,
  seedSessionState,
  sessionDiffersFromDefaults,
  sessionStorageKey,
  sessionSubtitleParts,
  type ChatSessionState,
  type SessionSeed,
} from "./session-state";

const SEED: SessionSeed = {
  defaultAgentId: "agt_default",
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

function base(overrides: Partial<ChatSessionState> = {}): ChatSessionState {
  return { ...defaultChatSessionState, ...overrides };
}

describe("applySessionPatch", () => {
  it("an explicit model clears tier, and vice versa", () => {
    const withModel = applySessionPatch(base({ tier: "fast" }), {
      model: "anthropic/claude-sonnet-5",
    });
    expect(withModel.tier).toBeNull();
    const withTier = applySessionPatch(withModel, { tier: "precise" });
    expect(withTier.model).toBeNull();
  });

  it("merges every other field straight through", () => {
    const next = applySessionPatch(base(), {
      agentId: "agt_1",
      effort: "high",
      budgetUsd: 2,
    });
    expect(next).toEqual(
      base({ agentId: "agt_1", effort: "high", budgetUsd: 2 }),
    );
  });

  it("carries no repo/branch/environment fields (ADR-043)", () => {
    expect(Object.keys(defaultChatSessionState).sort()).toEqual([
      "agentId",
      "budgetUsd",
      "effort",
      "model",
      "tier",
    ]);
  });
});

describe("seedSessionState", () => {
  it("seeds from the workspace defaults", () => {
    const seeded = seedSessionState(SEED);
    expect(seeded.agentId).toBe("agt_default");
    expect(seeded.tier).toBe("fast");
    expect(seeded.model).toBeNull();
    expect(seeded.budgetUsd).toBeNull();
  });

  it("prefers an explicit default model over the tier", () => {
    const seeded = seedSessionState({
      ...SEED,
      textModel: "anthropic/claude-sonnet-5",
    });
    expect(seeded.model).toBe("anthropic/claude-sonnet-5");
    expect(seeded.tier).toBeNull();
  });
});

// The agent lock is derived from ONE input — server truth. The shell passes
// `hasMessages = messages.length > 0 || isStreaming`, and isStreaming flips
// synchronously at submit, so there is no send→revalidate gap for a client-side
// latch to cover (and a failed send correctly releases the lock again).
describe("computeSessionLocks", () => {
  it("locks the agent after the first message", () => {
    expect(computeSessionLocks({ hasMessages: true })).toEqual({ agent: true });
  });
  it("a brand-new chat is unlocked", () => {
    expect(computeSessionLocks({ hasMessages: false })).toEqual({
      agent: false,
    });
  });
});

describe("sessionDiffersFromDefaults", () => {
  const defaults = seedSessionState(SEED);
  it("false when identical", () => {
    expect(sessionDiffersFromDefaults({ ...defaults }, defaults)).toBe(false);
  });
  it("true on any changed field", () => {
    expect(
      sessionDiffersFromDefaults({ ...defaults, effort: "high" }, defaults),
    ).toBe(true);
    expect(
      sessionDiffersFromDefaults({ ...defaults, budgetUsd: 2 }, defaults),
    ).toBe(true);
    expect(
      sessionDiffersFromDefaults({ ...defaults, agentId: "agt_x" }, defaults),
    ).toBe(true);
  });
});

describe("sessionSubtitleParts", () => {
  it("renders the model label alone when the turn is uncapped", () => {
    expect(sessionSubtitleParts(base(), { modelLabel: "Fast" })).toEqual({
      model: "Fast",
      budget: null,
    });
  });

  it("formats the per-turn cap when one is set", () => {
    expect(
      sessionSubtitleParts(base({ budgetUsd: 1 }), { modelLabel: "Sonnet" }),
    ).toEqual({ model: "Sonnet", budget: "$1.00 cap" });
  });
});

describe("persistence codecs", () => {
  it("round-trips a full state", () => {
    const state = base({
      agentId: "agt_1",
      tier: null,
      model: "anthropic/claude-sonnet-5",
      effort: "high",
      budgetUsd: 2,
    });
    expect(
      decodeSessionState(encodeSessionState(state), defaultChatSessionState),
    ).toEqual(state);
  });

  it("rejects wrong versions and corrupt JSON", () => {
    expect(decodeSessionState(null, defaultChatSessionState)).toBeNull();
    expect(decodeSessionState("not json", defaultChatSessionState)).toBeNull();
    expect(
      decodeSessionState(
        JSON.stringify({ v: 99, agentId: "x" }),
        defaultChatSessionState,
      ),
    ).toBeNull();
  });

  it("sanitizes invalid fields to the base instead of discarding the rest", () => {
    const decoded = decodeSessionState(
      JSON.stringify({
        v: 1,
        agentId: "agt_1",
        tier: "warp-speed",
        effort: "impossible",
        budgetUsd: -4,
      }),
      defaultChatSessionState,
    );
    expect(decoded?.agentId).toBe("agt_1");
    expect(decoded?.tier).toBe(defaultChatSessionState.tier);
    expect(decoded?.effort).toBe(defaultChatSessionState.effort);
    expect(decoded?.budgetUsd).toBeNull();
  });
});

describe("storage keys", () => {
  it("scopes conversation and draft keys", () => {
    expect(sessionStorageKey("ws", "cnv_1")).toBe(
      "oxagen:chat-session:v1:conv:cnv_1",
    );
    expect(sessionStorageKey("ws", null)).toBe(
      "oxagen:chat-session:v1:draft:ws",
    );
    expect(sessionStorageKey(undefined, null)).toBe(
      "oxagen:chat-session:v1:draft:_",
    );
  });
});
