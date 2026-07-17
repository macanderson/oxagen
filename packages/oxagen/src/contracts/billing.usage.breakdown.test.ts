import { describe, expect, it } from "vitest";
import { billingUsageBreakdown } from "./billing.usage.breakdown";

const validInput = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-07-01T00:00:00.000Z",
};

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
      totals: {
        inputTokens: 100,
        outputTokens: 40,
        cachedTokens: 10,
        costMicros: 5000,
        executions: 3,
        messages: 2,
      },
      series: [
        {
          day: "2026-06-01",
          inputTokens: 100,
          outputTokens: 40,
          cachedTokens: 10,
          costMicros: 5000,
          executions: 3,
          messages: 2,
        },
      ],
      byModel: [
        {
          key: "claude-sonnet-5",
          provider: "anthropic",
          inputTokens: 100,
          outputTokens: 40,
          cachedTokens: 10,
          costMicros: 5000,
          executions: 3,
          messages: 2,
        },
      ],
      bySurface: [
        {
          key: "api",
          provider: "",
          inputTokens: 100,
          outputTokens: 40,
          cachedTokens: 10,
          costMicros: 5000,
          executions: 3,
          messages: 2,
        },
      ],
      byWorkspace: [],
      byCapability: [
        {
          key: "query_ontology",
          provider: "",
          inputTokens: 60,
          outputTokens: 20,
          cachedTokens: 5,
          costMicros: 3000,
          executions: 2,
          messages: 1,
        },
      ],
      byPrincipal: [
        {
          principalId: "00000000-0000-0000-0000-0000000000e5",
          principalKind: "agent",
          inputTokens: 60,
          outputTokens: 20,
          cachedTokens: 5,
          costMicros: 3000,
          executions: 2,
          messages: 1,
        },
      ],
      byUser: [
        {
          userId: "00000000-0000-0000-0000-0000000000e5",
          inputTokens: 60,
          outputTokens: 20,
          cachedTokens: 5,
          costMicros: 3000,
          executions: 2,
          messages: 1,
        },
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
        totals: {
          inputTokens: -1,
          outputTokens: 0,
          cachedTokens: 0,
          costMicros: 0,
          executions: 0,
          messages: 0,
        },
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
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          costMicros: 0,
          executions: 0,
        },
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
