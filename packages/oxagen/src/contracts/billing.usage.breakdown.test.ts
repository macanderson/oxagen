import { describe, expect, it } from "vitest";
import { billingUsageBreakdown } from "./billing.usage.breakdown";

const validInput = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-07-01T00:00:00.000Z",
};

/**
 * One fully-populated totals shape, shared by every breakdown row in the
 * fixture below. The contract extends this shape into seven places (totals,
 * series, byModel, bySurface, byWorkspace, byCapability, byPrincipal, byUser);
 * keeping a single literal here means a new required field is added once
 * instead of drifting across seven hand-written copies.
 */
function makeTotals(overrides: Record<string, number> = {}) {
  return {
    inputTokens: 100,
    outputTokens: 40,
    cachedTokens: 10,
    cacheWriteTokens: 20,
    costMicros: 5000,
    executions: 3,
    messages: 2,
    ...overrides,
  };
}

/** Smaller per-row totals used by the capability/principal/user breakdowns. */
const smallTotals = makeTotals({
  inputTokens: 60,
  outputTokens: 20,
  cachedTokens: 5,
  cacheWriteTokens: 8,
  costMicros: 3000,
  executions: 2,
  messages: 1,
});

describe("billing.usage.breakdown capability", () => {
  it("registers as a read-only, ungated, org-scoped billing capability", () => {
    expect(billingUsageBreakdown.name).toBe("get_usage_breakdown");
    expect(billingUsageBreakdown.domain).toBe("billing");
    expect(billingUsageBreakdown.scoped).toBe(true);
    // Reading your own spend must not consume credits.
    expect(billingUsageBreakdown.noBillingGate).toBe(true);
    expect(billingUsageBreakdown.defaultEffect).toBe("deny");
    expect(billingUsageBreakdown.defaultRoles.org).toMatchObject({
      Owner: "allow",
      Admin: "allow",
      Billing: "allow",
    });
    expect(billingUsageBreakdown.surfaces).toContain("mcp");
    expect(billingUsageBreakdown.surfaces).toContain("api");
  });

  it("parses a valid window", () => {
    const parsed = billingUsageBreakdown.input.parse(validInput);
    expect(parsed.start).toBe(validInput.start);
    expect(parsed.workspaceId).toBeUndefined();
  });

  it("accepts an optional workspace UUID", () => {
    const parsed = billingUsageBreakdown.input.parse({
      ...validInput,
      workspaceId: "22222222-2222-2222-2222-222222222222",
    });
    expect(parsed.workspaceId).toBe("22222222-2222-2222-2222-222222222222");
  });

  it("rejects end before start", () => {
    expect(() =>
      billingUsageBreakdown.input.parse({
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/end must be after start/);
  });

  it("rejects a window longer than 366 days", () => {
    expect(() =>
      billingUsageBreakdown.input.parse({
        start: "2025-01-01T00:00:00.000Z",
        end: "2026-06-01T00:00:00.000Z",
      }),
    ).toThrow(/366 days/);
  });

  it("rejects a non-ISO start", () => {
    expect(() =>
      billingUsageBreakdown.input.parse({ ...validInput, start: "2026-06-01" }),
    ).toThrow();
  });

  it("rejects a non-UUID workspaceId", () => {
    expect(() =>
      billingUsageBreakdown.input.parse({ ...validInput, workspaceId: "nope" }),
    ).toThrow();
  });

  it("parses a fully-populated output", () => {
    const parsed = billingUsageBreakdown.output.parse({
      range: validInput,
      totals: makeTotals(),
      // Net of the cache-write premium; can be negative, here it is positive.
      cacheSavingsMicros: 1200,
      series: [{ day: "2026-06-01", ...makeTotals() }],
      byModel: [
        { key: "claude-sonnet-5", provider: "anthropic", ...makeTotals() },
      ],
      bySurface: [{ key: "api", provider: "", ...makeTotals() }],
      byWorkspace: [],
      byCapability: [{ key: "query_ontology", provider: "", ...smallTotals }],
      byPrincipal: [
        {
          principalId: "00000000-0000-0000-0000-0000000000e5",
          principalKind: "agent",
          ...smallTotals,
        },
      ],
      byUser: [
        { userId: "00000000-0000-0000-0000-0000000000e5", ...smallTotals },
      ],
    });
    expect(parsed.byModel[0]?.provider).toBe("anthropic");
    expect(parsed.byPrincipal[0]?.principalKind).toBe("agent");
    expect(parsed.byUser[0]?.userId).toBe(
      "00000000-0000-0000-0000-0000000000e5",
    );
    expect(parsed.totals.messages).toBe(2);
  });

  it("rejects a negative token count in the output", () => {
    expect(() =>
      billingUsageBreakdown.output.parse({
        range: validInput,
        totals: makeTotals({ inputTokens: -1 }),
        cacheSavingsMicros: 0,
        series: [],
        byModel: [],
        bySurface: [],
        byWorkspace: [],
        byCapability: [],
        byPrincipal: [],
        byUser: [],
      }),
    ).toThrow();
  });

  it("rejects an output missing the messages count", () => {
    expect(() =>
      billingUsageBreakdown.output.parse({
        range: validInput,
        totals: (() => {
          const { messages: _omitted, ...rest } = makeTotals({
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            costMicros: 0,
            executions: 0,
          });
          return rest;
        })(),
        cacheSavingsMicros: 0,
        series: [],
        byModel: [],
        bySurface: [],
        byWorkspace: [],
        byCapability: [],
        byPrincipal: [],
        byUser: [],
      }),
    ).toThrow();
  });
});
