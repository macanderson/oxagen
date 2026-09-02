/**
 * Unit tests for usage.ts — getCurrentPeriodUsage.
 *
 * Covers:
 *  - Returns empty array when no active subscription exists
 *  - Calls sumTokenUsage with period bounds from the active subscription
 *  - Returns the rollup rows from sumTokenUsage
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface SubState {
  row:
    | {
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
      }
    | undefined;
}

const subState: SubState = { row: undefined };

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => {
      const tx = {
        query: {
          subscriptions: {
            findFirst: vi.fn(async () => subState.row),
          },
        },
      };
      return fn(tx);
    },
  };
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
});
