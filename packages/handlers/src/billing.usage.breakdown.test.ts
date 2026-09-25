/**
 * billing.usage.breakdown handler tests
 *
 * Strategy: stub @oxagen/telemetry's `readUsageBreakdown` and
 * `readObservedModels` so no live ClickHouse is required, and the price-book
 * read so no Postgres is. Assert the tenant boundary (ctx.orgId, never the
 * input), the threading of input.workspaceId, date coercion, the echoed
 * range/output, and that the cache saving is priced from the book per
 * price-boundary bucket (#4069).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// The handler's role gate (#4194) runs for real against a role fixture. The
// default caller is an org Owner; a case that needs another sets roleGate.
vi.mock("@oxagen/iam/org-role", async () =>
  (await import("./test-utils/org-role-gate")).orgRoleModule(),
);
import type { PriceEntry } from "@oxagen/billing";

const mocks = vi.hoisted(() => ({
  readUsageBreakdown: vi.fn(),
  readObservedModels: vi.fn(),
  loadPriceBookInTenantScope: vi.fn(),
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    readUsageBreakdown: mocks.readUsageBreakdown,
    readObservedModels: mocks.readObservedModels,
  };
});

vi.mock("@oxagen/billing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/billing")>();
  return {
    ...real,
    loadPriceBookInTenantScope: mocks.loadPriceBookInTenantScope,
  };
});

import { billingUsageBreakdownHandler } from "./billing.usage.breakdown";
import { TEST_CTX } from "./test-utils/fixtures";
import { resetRoleGate, roleGate } from "./test-utils/org-role-gate";

const BREAKDOWN = {
  totals: {
    inputTokens: 100,
    outputTokens: 40,
    cachedTokens: 10,
    cacheWriteTokens: 20,
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
      cacheWriteTokens: 20,
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
      cacheWriteTokens: 20,
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
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  byWorkspace: [
    {
      key: "ws-a",
      provider: "",
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      cacheWriteTokens: 20,
      costMicros: 5000,
      executions: 3,
      messages: 2,
    },
  ],
  byCapability: [
    {
      key: "query_ontology",
      provider: "",
      inputTokens: 60,
      outputTokens: 20,
      cachedTokens: 5,
      cacheWriteTokens: 10,
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
      cacheWriteTokens: 10,
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
      cacheWriteTokens: 10,
      costMicros: 3000,
      executions: 2,
      messages: 1,
    },
  ],
};

const RATE_CHANGE = new Date("2026-06-15T00:00:00.000Z");

function entry(
  overrides: Partial<PriceEntry> & Pick<PriceEntry, "id" | "tokenClass">,
): PriceEntry {
  return {
    orgId: null,
    provider: "anthropic",
    model: "claude-sonnet-5",
    modelAliases: [],
    region: null,
    unit: "token",
    currency: "USD",
    microsPerMillion: 2_000_000n,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    source: "list",
    ...overrides,
  };
}

/**
 * The book: input $2 per 1M until mid-June and $3 after it; cache reads
 * $0.20 and 5-minute writes $2.50 throughout. The in-code card prices the
 * model at one rate for the whole window, so a figure from it cannot match.
 */
const BOOK: PriceEntry[] = [
  entry({
    id: "pe_in_old",
    tokenClass: "input_uncached",
    effectiveTo: RATE_CHANGE,
  }),
  entry({
    id: "pe_in_new",
    tokenClass: "input_uncached",
    microsPerMillion: 3_000_000n,
    effectiveFrom: RATE_CHANGE,
  }),
  entry({ id: "pe_cr", tokenClass: "cache_read", microsPerMillion: 200_000n }),
  entry({
    id: "pe_w5",
    tokenClass: "cache_write_5m",
    microsPerMillion: 2_500_000n,
  }),
];

/** The class-bucket read: the same 10 reads and 20 writes, split at the rate change. */
const OBSERVED = [
  {
    model: "claude-sonnet-5",
    provider: "anthropic",
    calls: 3,
    tokens: 130,
    firstSeen: "2026-06-02T00:00:00.000Z",
    lastSeen: "2026-06-20T00:00:00.000Z",
    classes: [
      {
        tokenClass: "cache_read",
        calls: 1,
        tokens: 4,
        firstSeen: "2026-06-02T00:00:00.000Z",
        lastSeen: "2026-06-02T00:00:00.000Z",
      },
      {
        tokenClass: "cache_read",
        calls: 2,
        tokens: 6,
        firstSeen: "2026-06-20T00:00:00.000Z",
        lastSeen: "2026-06-20T00:00:00.000Z",
      },
      {
        tokenClass: "cache_write_5m",
        calls: 1,
        tokens: 20,
        firstSeen: "2026-06-02T00:00:00.000Z",
        lastSeen: "2026-06-02T00:00:00.000Z",
      },
      {
        tokenClass: "output",
        calls: 3,
        tokens: 40,
        firstSeen: "2026-06-02T00:00:00.000Z",
        lastSeen: "2026-06-20T00:00:00.000Z",
      },
    ],
  },
];

const INPUT = {
  start: "2026-06-01T00:00:00.000Z",
  end: "2026-07-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readUsageBreakdown.mockResolvedValue(BREAKDOWN);
  mocks.loadPriceBookInTenantScope.mockResolvedValue(BOOK);
  mocks.readObservedModels.mockResolvedValue(OBSERVED);
});

describe("billingUsageBreakdownHandler (@oxagen/handlers)", () => {
  it("scopes the read to ctx.orgId and echoes the range + breakdown", async () => {
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);

    const arg = mocks.readUsageBreakdown.mock.calls[0]![0];
    expect(arg.orgId).toBe(TEST_CTX.orgId);
    expect(arg.workspaceId).toBeUndefined();
    expect(arg.start).toEqual(new Date(INPUT.start));
    expect(arg.end).toEqual(new Date(INPUT.end));

    expect(out.range).toEqual({ start: INPUT.start, end: INPUT.end });
    expect(out.totals).toEqual(BREAKDOWN.totals);
    expect(out.byModel).toEqual(BREAKDOWN.byModel);
    expect(out.bySurface).toEqual(BREAKDOWN.bySurface);
    expect(out.byWorkspace).toEqual(BREAKDOWN.byWorkspace);
    expect(out.byCapability).toEqual(BREAKDOWN.byCapability);
    expect(out.byPrincipal).toEqual(BREAKDOWN.byPrincipal);
    expect(out.byUser).toEqual(BREAKDOWN.byUser);
    expect(out.series).toEqual(BREAKDOWN.series);
  });

  it("prices net cache savings from the price book at each bucket's rates (#1076, #4069)", async () => {
    // Before the rate change, at input $2:
    //   reads saved = 4 × (2.0 − 0.2)  = 7.2 micro-USD
    //   writes cost = 20 × (2.5 − 2.0) = 10  micro-USD
    // After it, at input $3:
    //   reads saved = 6 × (3.0 − 0.2)  = 16.8 micro-USD
    // net = 7.2 − 10 + 16.8 = 14 micro-USD, rounded once. The rate card's
    // one rate for the window answered 8 for the same tokens.
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.cacheSavingsMicros).toBe(14);
  });

  it("reads the gateway store alone over the breakdown's window, bucketed at the book's cache boundaries", async () => {
    const wsId = "22222222-2222-2222-2222-222222222222";
    await billingUsageBreakdownHandler(
      { ...INPUT, workspaceId: wsId },
      TEST_CTX,
    );
    expect(mocks.loadPriceBookInTenantScope).toHaveBeenCalledWith({
      orgId: TEST_CTX.orgId,
    });
    const arg = mocks.readObservedModels.mock.calls[0]![0];
    expect(arg).toMatchObject({
      orgId: TEST_CTX.orgId,
      workspaceId: wsId,
      since: new Date(INPUT.start),
      // The breakdown's end is exclusive; the bucket read's bound is not.
      until: new Date(new Date(INPUT.end).getTime() - 1),
      frameStores: "gateway",
    });
    // The rate change inside the window is the one boundary that splits it.
    expect(arg.boundariesFor(["claude-sonnet-5"])).toEqual([RATE_CHANGE]);
    expect(arg.boundariesFor(["unrelated-model"])).toEqual([]);
  });

  it("reports zero cache savings when no tokens were cached", async () => {
    mocks.readObservedModels.mockResolvedValueOnce([
      { ...OBSERVED[0], classes: [OBSERVED[0]!.classes[3]] },
    ]);
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.cacheSavingsMicros).toBe(0);
  });

  it("leaves out a bucket the book cannot price rather than guessing a rate", async () => {
    mocks.loadPriceBookInTenantScope.mockResolvedValueOnce(
      BOOK.filter((e) => e.tokenClass !== "cache_write_5m"),
    );
    // 7.2 + 16.8 in reads; the writes have no price, so no premium is netted.
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.cacheSavingsMicros).toBe(24);
  });

  it("propagates a price-book read failure (no silent zeros)", async () => {
    mocks.loadPriceBookInTenantScope.mockRejectedValueOnce(
      new Error("postgres down"),
    );
    await expect(billingUsageBreakdownHandler(INPUT, TEST_CTX)).rejects.toThrow(
      "postgres down",
    );
  });

  it("threads input.workspaceId to narrow within the org", async () => {
    const wsId = "22222222-2222-2222-2222-222222222222";
    await billingUsageBreakdownHandler(
      { ...INPUT, workspaceId: wsId },
      TEST_CTX,
    );
    const arg = mocks.readUsageBreakdown.mock.calls[0]![0];
    expect(arg.orgId).toBe(TEST_CTX.orgId);
    expect(arg.workspaceId).toBe(wsId);
  });

  it("propagates ClickHouse errors (no silent zeros)", async () => {
    mocks.readUsageBreakdown.mockRejectedValue(new Error("clickhouse down"));
    await expect(billingUsageBreakdownHandler(INPUT, TEST_CTX)).rejects.toThrow(
      "clickhouse down",
    );
  });
});

// The contract grants org Owner, Admin, or Billing. The kernel's IAM check
// allows every capability for a non-enterprise org, so the handler is the
// only gate there (#4194). The spend it discloses is the org's whole bill.
describe("billingUsageBreakdownHandler role gate", () => {
  beforeEach(() => resetRoleGate());

  it("refuses a workspace Member as forbidden, before any usage read", async () => {
    roleGate.roles = { org: null, workspace: "Member" };
    await expect(
      billingUsageBreakdownHandler(INPUT, TEST_CTX),
    ).rejects.toMatchObject({ code: "forbidden", reason: "org_role_required" });
    expect(mocks.readUsageBreakdown).not.toHaveBeenCalled();
    expect(mocks.loadPriceBookInTenantScope).not.toHaveBeenCalled();
  });

  it("allows an org Billing member", async () => {
    roleGate.roles = { org: "Billing" };
    const out = await billingUsageBreakdownHandler(INPUT, TEST_CTX);
    expect(out.totals.executions).toBe(3);
  });

  it("acts as an API key's creator, and refuses a key with none", async () => {
    roleGate.roles = { org: "Owner", keyCreator: null };
    await expect(
      billingUsageBreakdownHandler(INPUT, {
        ...TEST_CTX,
        userId: null,
        apiKeyId: "key_1",
      }),
    ).rejects.toMatchObject({ code: "forbidden", reason: "no_principal" });
  });
});
