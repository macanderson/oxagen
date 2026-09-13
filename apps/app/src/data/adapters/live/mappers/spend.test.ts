import type { schema } from "@oxagen/database";
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { billingUsageBreakdown } from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { describe, expect, it, vi } from "vitest";
import { Budget, SpendByModel } from "@/data/contracts";
import {
  cacheHitRate,
  MAX_EXACT_MICROS,
  moneyFromMicros,
  moneyFromUsd,
  monthWindow,
  SpendContractMismatch,
  type SpendBudgetStatus,
  toBudget,
  toSpendByModel,
  UNRECORDED_MODEL_PATHS,
  type UsageModelRow,
} from "./spend";

// ---- The real rows -----------------------------------------------------------
//
// ClickHouse: readUsageBreakdown's query answers JSONEachRow with UInt64 sums as
// decimal strings. The real reader and the real get_usage_breakdown handler
// turn that row into the contract's output; the ClickHouse client is the only
// fake. Postgres: a `billing.spend_budgets` row typed from drizzle's
// $inferSelect goes through the store's row mapping and the real
// get_spend_budget handler; only the store read and the spend sum are fakes.

const ch = vi.hoisted(() => {
  // The handlers log through pino at import; keep the test output to results.
  process.env.LOG_LEVEL ??= "silent";
  return {
    rows: [] as Array<Record<string, string>>,
    queries: [] as string[],
  };
});

vi.mock("../../../../../../../packages/telemetry/src/clickhouse", () => ({
  clickhouse: () => ({
    query: ({ query }: { query: string }) => {
      ch.queries.push(query);
      // Only the model breakdown carries rows; every other grouping is empty.
      const rows = query.includes("any(provider)") ? ch.rows : [];
      return Promise.resolve({ json: () => Promise.resolve(rows) });
    },
  }),
}));

vi.mock("@oxagen/telemetry", async () => {
  const analytics = await vi.importActual<
    typeof import("../../../../../../../packages/telemetry/src/usage-analytics")
  >("../../../../../../../packages/telemetry/src/usage-analytics");
  return { readUsageBreakdown: analytics.readUsageBreakdown };
});

type SpendBudgetRowSelect = typeof schema.spendBudgets.$inferSelect;
const pg = vi.hoisted(() => ({
  rows: [] as unknown[],
  spentMicros: new Map<string | null, bigint>(),
}));

vi.mock("@oxagen/billing", async () => {
  // The real rate card: the handler prices cache savings with it.
  const pricing = await vi.importActual<
    typeof import("../../../../../../../packages/billing/src/pricing")
  >("../../../../../../../packages/billing/src/pricing");
  return {
    resolveRate: pricing.resolveRate,
    // Mirrors spend-budget-store's rowToBudgetRow and getSpendBudgetStatuses'
    // arithmetic for the fields the handler reads.
    getSpendBudgetStatuses: () =>
      Promise.resolve(
        (pg.rows as SpendBudgetRowSelect[]).map((row) => {
          const spentMicros = pg.spentMicros.get(row.workspaceId) ?? 0n;
          const limitMicros = BigInt(row.limitMicros);
          const ratio = Number(spentMicros) / Number(limitMicros);
          return {
            budget: {
              scope: row.workspaceId === null ? "org" : "workspace",
              orgId: row.orgId,
              workspaceId: row.workspaceId,
              enabled: row.enabled,
              period: row.period,
              windowDays: row.windowDays,
              limitMicros,
              id: row.id,
              publicId: row.publicId,
              notifiedThreshold: row.notifiedThreshold,
              notifiedPeriodStart: row.notifiedPeriodStart,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            },
            spentMicros,
            ratio,
            state: ratio >= 1 ? "exceeded" : "ok",
            overLimit: ratio >= 1,
            reachedThreshold: 0,
            window: {
              start: "2026-09-01T00:00:00.000Z",
              end: "2026-09-12T09:00:00.000Z",
            },
            projectedMicros: spentMicros,
          };
        }),
      ),
  };
});

const { billingUsageBreakdownHandler } = await import(
  "@oxagen/handlers/billing.usage.breakdown"
);
const { billingBudgetGetHandler } = await import(
  "@oxagen/handlers/billing.budget.get"
);

const ORG = "0192d4a8-7c1e-7a00-8000-00000000ac3e";
const WS = "0192d4a8-7c1e-7a00-8000-0000000c0de0";
const CTX = {
  orgId: ORG,
  workspaceId: WS,
  userId: "0192d4a8-7c1e-7a00-8000-000000000b31",
  apiKeyId: null,
  requestId: "req-spend-contract",
  surface: "app",
  messageId: null,
} as const;

const clickhouseModelRow = (o: Record<string, string>) => ({
  group_key: "claude-sonnet-4-5",
  provider: "anthropic",
  input_tokens: "1250000",
  output_tokens: "84000",
  cached_tokens: "900000",
  cache_write_tokens: "50000",
  cost_micros: "2451730",
  executions: "412",
  messages: "140",
  ...o,
});

async function realModelRows(
  rows: Array<Record<string, string>>,
): Promise<UsageModelRow[]> {
  ch.rows = rows;
  ch.queries = [];
  const raw = await billingUsageBreakdownHandler(
    {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
      workspaceId: WS,
    },
    CTX as never,
  );
  return billingUsageBreakdown.output.parse(raw).byModel;
}

const budgetRow = (o: Partial<SpendBudgetRowSelect>): SpendBudgetRowSelect => ({
  id: "0192d4a8-7c1e-7a00-8000-0000000b0d9e",
  publicId: "bdg_01K5RS7Q2W",
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  updatedAt: new Date("2026-08-01T10:00:00.000Z"),
  createdByUserId: null,
  updatedByUserId: null,
  orgId: ORG,
  workspaceId: null,
  enabled: true,
  period: "monthly",
  windowDays: null,
  limitMicros: 25_000_000_000n,
  notifiedThreshold: 0,
  notifiedPeriodStart: null,
  ...o,
});

async function realBudgetStatuses(
  rows: SpendBudgetRowSelect[],
  spent: Array<[string | null, bigint]> = [],
): Promise<SpendBudgetStatus[]> {
  pg.rows = rows;
  pg.spentMicros = new Map(spent);
  const raw = await billingBudgetGetHandler({}, CTX as never);
  return billingBudgetGet.output.parse(raw).budgets;
}

const SLUGS = { org: "acme", workspace: "core-platform" };

// ---- Contract tests ------------------------------------------------------------

describe("token_usage → SpendByModel (contract)", () => {
  it("parses a real model row through get_usage_breakdown and the view model", async () => {
    const [row] = await realModelRows([clickhouseModelRow({})]);
    expect(row).toBeDefined();
    const candidate = toSpendByModel(row as UsageModelRow);
    expect(candidate.ok).toBe(true);
    if (!candidate.ok) return;
    const parsed = SpendByModel.parse(candidate.value);
    expect(parsed).toEqual({
      model: "claude-sonnet-4-5",
      assistant: true,
      calls: 412,
      spend: { micros: "2451730", currency: "USD", basis: "estimated" },
      // 900,000 cache reads over (1,250,000 inclusive input − 50,000 writes).
      cacheHitRate: 0.75,
    });
    // The workspace narrowed every grouping (the tenant boundary is org_id).
    expect(
      ch.queries.every((q) => q.includes("workspace_id = {workspaceId:UUID}")),
    ).toBe(true);
  });

  it("leaves exactly the cache hit rate unrecorded for a model with no prompt tokens", async () => {
    const [row] = await realModelRows([
      clickhouseModelRow({
        group_key: "gpt-image-1",
        input_tokens: "0",
        cached_tokens: "0",
        cache_write_tokens: "0",
      }),
    ]);
    const candidate = toSpendByModel(row as UsageModelRow);
    expect(candidate).toEqual({
      ok: false,
      model: "gpt-image-1",
      unrecorded: "cacheHitRate",
    });
    expect(UNRECORDED_MODEL_PATHS).toEqual(["cacheHitRate"]);
  });

  it("does not fit SpendByModel with a zero standing in for the undefined rate", async () => {
    const [row] = await realModelRows([
      clickhouseModelRow({
        input_tokens: "0",
        cached_tokens: "0",
        cache_write_tokens: "0",
      }),
    ]);
    const withNull = {
      model: row?.key,
      assistant: true,
      calls: row?.executions,
      spend: { micros: String(row?.costMicros), currency: "USD" },
      cacheHitRate: null,
    };
    expect(SpendByModel.safeParse(withNull).success).toBe(false);
  });
});

describe("billing.spend_budgets → Budget (contract)", () => {
  it("parses a real org ceiling and workspace ceiling through get_spend_budget and the view model", async () => {
    const statuses = await realBudgetStatuses(
      [
        budgetRow({}),
        budgetRow({
          id: "0192d4a8-7c1e-7a00-8000-0000000b0d9f",
          publicId: "bdg_01K5RS7Q2X",
          workspaceId: WS,
          period: "rolling",
          windowDays: 7,
          limitMicros: 1_234_567_891n,
        }),
      ],
      [
        [null, 9_918_402_117n],
        [WS, 1_000_000_001n],
      ],
    );
    const budgets = statuses.map((s) => toBudget(s, SLUGS));
    expect(budgets.map((b) => Budget.parse(b))).toEqual([
      {
        scopeKind: "org",
        scopeId: "acme",
        period: "monthly",
        limit: { micros: "25000000000", currency: "USD" },
        spent: { micros: "9918402117", currency: "USD", basis: "estimated" },
        mode: "hard",
      },
      {
        scopeKind: "workspace",
        scopeId: "core-platform",
        period: "rolling",
        // The handler's float dollars come back to the exact bigint micros.
        limit: { micros: "1234567891", currency: "USD" },
        spent: { micros: "1000000001", currency: "USD", basis: "estimated" },
        mode: "hard",
      },
    ]);
  });

  it("drops a disabled ceiling instead of showing it as enforced", async () => {
    const [status] = await realBudgetStatuses([budgetRow({ enabled: false })]);
    expect(toBudget(status as SpendBudgetStatus, SLUGS)).toBeNull();
  });
});

// ---- Pure helpers ----------------------------------------------------------------

describe("monthWindow", () => {
  it("is the half-open calendar month in UTC", () => {
    expect(monthWindow(new Date("2026-09-12T23:59:59.999-07:00"))).toEqual({
      period: "2026-09",
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
    });
  });

  it("rolls December into the next year", () => {
    expect(monthWindow(new Date("2026-12-31T12:00:00Z"))).toEqual({
      period: "2026-12",
      start: "2026-12-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("moneyFromMicros", () => {
  it("carries integer micros as a decimal string, with a basis when given", () => {
    expect(moneyFromMicros("f", 41265, "estimated")).toEqual({
      micros: "41265",
      currency: "USD",
      basis: "estimated",
    });
    expect(moneyFromMicros("f", 0)).toEqual({ micros: "0", currency: "USD" });
  });

  it("refuses a fraction, NaN or an amount a float cannot carry exactly", () => {
    expect(() => moneyFromMicros("a", 1.5)).toThrow(SpendContractMismatch);
    expect(() => moneyFromMicros("b", Number.NaN)).toThrow(
      SpendContractMismatch,
    );
    expect(() => moneyFromMicros("c", MAX_EXACT_MICROS + 2)).toThrow(
      /spend value at c cannot be carried exactly/,
    );
  });
});

describe("moneyFromUsd", () => {
  it.each([
    1n,
    999_999n,
    1_000_001n,
    123_456_789_012n,
    BigInt(MAX_EXACT_MICROS),
  ])("round-trips %s micros through the handler's float dollars", (micros) => {
    expect(moneyFromUsd("f", Number(micros) / 1_000_000).micros).toBe(
      String(micros),
    );
  });

  it("refuses a non-finite dollar amount", () => {
    expect(() => moneyFromUsd("f", Number.POSITIVE_INFINITY)).toThrow(
      SpendContractMismatch,
    );
  });
});

describe("cacheHitRate", () => {
  it("is cache reads over uncached input plus cache reads", () => {
    expect(
      cacheHitRate({
        inputTokens: 1000,
        cachedTokens: 600,
        cacheWriteTokens: 200,
      }),
    ).toBe(0.75);
  });

  it("is a true zero when prompt tokens were sent and none came from cache", () => {
    expect(
      cacheHitRate({ inputTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(0);
  });

  it("is null, not zero, when there were no prompt tokens", () => {
    expect(
      cacheHitRate({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }),
    ).toBeNull();
    expect(
      cacheHitRate({ inputTokens: 50, cachedTokens: 0, cacheWriteTokens: 50 }),
    ).toBeNull();
  });

  it("is null when the sums contradict each other", () => {
    expect(
      cacheHitRate({
        inputTokens: 100,
        cachedTokens: 150,
        cacheWriteTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("toBudget", () => {
  const status = (o: Partial<SpendBudgetStatus>): SpendBudgetStatus => ({
    scope: "workspace",
    publicId: "bdg_01K5RS7Q2X",
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitUsd: 100,
    spentUsd: 12.5,
    projectedUsd: 30,
    ratio: 0.125,
    state: "ok",
    reachedThreshold: 0,
    windowStart: "2026-09-01T00:00:00.000Z",
    windowEnd: "2026-09-12T09:00:00.000Z",
    ...o,
  });

  it("drops a status with no limit configured", () => {
    expect(toBudget(status({ limitUsd: null }), SLUGS)).toBeNull();
  });

  it("refuses a workspace ceiling without the workspace's slug", () => {
    expect(() =>
      toBudget(status({}), { org: "acme", workspace: null }),
    ).toThrow(SpendContractMismatch);
    expect(() =>
      toBudget(status({ publicId: null }), { org: "acme", workspace: null }),
    ).toThrow(/budgets\.scopeId/);
  });

  it("shows an org ceiling by the organization slug even without a workspace slug", () => {
    expect(
      toBudget(status({ scope: "org", publicId: null }), {
        org: "acme",
        workspace: null,
      }),
    ).toMatchObject({ scopeKind: "org", scopeId: "acme" });
  });
});
