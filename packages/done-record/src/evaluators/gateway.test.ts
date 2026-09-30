// gateway.test.ts: merging several stages' gateway records keeps every call in
// order, adds the counters, and is only as strong as the weakest stage.
import { describe, expect, it } from "vitest";
import { mergeGatewayRecords } from "./gateway";
import type { GatewayRecords, UsageRecord } from "./types";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    usd: 1,
    tokens: 100,
    toolCalls: 2,
    minutes: 3,
    retries: 1,
    stopAttempts: 1,
    ...overrides,
  };
}

function stage(overrides: Partial<GatewayRecords> = {}): GatewayRecords {
  return {
    tier: "contained",
    basis: "gateway_observed",
    toolCalls: [],
    usage: usage(),
    ...overrides,
  };
}

describe("mergeGatewayRecords", () => {
  it("returns one stage's records unchanged", () => {
    const only = stage({ toolCalls: [{ tool: "Read", input: { file_path: "a" } }] });
    expect(mergeGatewayRecords([only])).toEqual(only);
  });

  it("adds the counters and keeps the calls in stage order", () => {
    const merged = mergeGatewayRecords([
      stage({ toolCalls: [{ tool: "Read", input: {} }] }),
      stage({
        toolCalls: [
          { tool: "Edit", input: {} },
          { tool: "Bash", input: { command: "ls" } },
        ],
        usage: usage({ usd: 0.5, stopAttempts: 2 }),
      }),
    ]);
    expect(merged.toolCalls.map((call) => call.tool)).toEqual(["Read", "Edit", "Bash"]);
    expect(merged.usage).toEqual({
      usd: 1.5,
      tokens: 200,
      toolCalls: 4,
      minutes: 6,
      retries: 2,
      stopAttempts: 3,
    });
  });

  it("takes the weakest tier", () => {
    const tiers = mergeGatewayRecords([
      stage({ tier: "contained" }),
      stage({ tier: "harness" }),
      stage({ tier: "gateway" }),
    ]).tier;
    expect(tiers).toBe("harness");
    expect(mergeGatewayRecords([stage({ tier: "observe" }), stage()]).tier).toBe(
      "observe",
    );
  });

  it("marks the basis mixed when the stages disagree", () => {
    expect(
      mergeGatewayRecords([stage(), stage({ basis: "client_attested" })]).basis,
    ).toBe("mixed");
    expect(mergeGatewayRecords([stage(), stage()]).basis).toBe("gateway_observed");
  });

  it("reports no cost when any stage reported none", () => {
    const merged = mergeGatewayRecords([
      stage({ usage: usage({ usd: null }) }),
      stage(),
    ]);
    expect(merged.usage.usd).toBeNull();
    const later = mergeGatewayRecords([stage(), stage({ usage: usage({ usd: null }) })]);
    expect(later.usage.usd).toBeNull();
  });

  it("throws when there is no stage to merge", () => {
    expect(() => mergeGatewayRecords([])).toThrow(TypeError);
  });
});
