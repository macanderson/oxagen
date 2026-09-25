/**
 * Unit tests for usage.ts — getCurrentPeriodUsage.
 *
 * Covers:
 *  - Returns empty array when no active subscription exists
 *  - Calls sumTokenUsage with period bounds from the active subscription
 *  - Returns the rollup rows from sumTokenUsage
 *  - Counts a trialing, past-due or paused subscription, not only `active`
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

interface SubState {
  row:
    | {
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
      }
    | undefined;
  /** The `where` clause of the last findFirst call, kept for inspection. */
  where: SQL | undefined;
}

const subState: SubState = { row: undefined, where: undefined };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => {
      const tx = {
        query: {
          subscriptions: {
            findFirst: vi.fn(async (args: { where?: SQL }) => {
              subState.where = args.where;
              return subState.row;
            }),
          },
        },
      };
      return fn(tx);
    },
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

const sumTokenUsageMock = vi.fn().mockResolvedValue([]);

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    sumTokenUsage: sumTokenUsageMock,
  };
});

const { getCurrentPeriodUsage } = await import("./usage");

describe("getCurrentPeriodUsage", () => {
  const periodStart = new Date("2026-06-01T00:00:00Z");
  const periodEnd = new Date("2026-07-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    subState.row = undefined;
    subState.where = undefined;
  });

  it("returns empty array when no active subscription exists", async () => {
    subState.row = undefined;
    const result = await getCurrentPeriodUsage("org-1");
    expect(result).toEqual([]);
    expect(sumTokenUsageMock).not.toHaveBeenCalled();
  });

  it("calls sumTokenUsage with period bounds from active subscription", async () => {
    subState.row = {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    };
    sumTokenUsageMock.mockResolvedValue([]);
    await getCurrentPeriodUsage("org-1");
    expect(sumTokenUsageMock).toHaveBeenCalledWith({
      orgId: "org-1",
      periodStart,
      periodEnd,
    });
  });

  it("returns the rollup rows from sumTokenUsage", async () => {
    subState.row = {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    };
    const mockRows = [
      { metric: "input_tokens", quantity: 10000, costMicros: 30000n },
      { metric: "output_tokens", quantity: 2000, costMicros: 60000n },
    ];
    sumTokenUsageMock.mockResolvedValue(mockRows);
    const result = await getCurrentPeriodUsage("org-1");
    expect(result).toEqual(mockRows);
  });

  it("passes the correct orgId to sumTokenUsage", async () => {
    subState.row = {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    };
    sumTokenUsageMock.mockResolvedValue([]);
    await getCurrentPeriodUsage("org-xyz-999");
    expect(sumTokenUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-xyz-999" }),
    );
  });

  // #2976: the filter read `status = 'active'`, so a trialing org got an
  // empty rollup. The mock returns the row whatever the filter says, so the
  // test renders the where clause and checks which statuses it admits.
  it("admits every entitled subscription status in the filter", async () => {
    subState.row = {
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
    };
    await getCurrentPeriodUsage("org-1");

    expect(subState.where).toBeDefined();
    const { sql, params } = new PgDialect().sqlToQuery(subState.where as SQL);
    expect(sql).toMatch(/"status" in \(/);
    expect(params).toEqual(
      expect.arrayContaining(["trialing", "active", "past_due", "paused"]),
    );
    expect(params).not.toContain("canceled");
    expect(params).toContain("org-1");
  });
});
