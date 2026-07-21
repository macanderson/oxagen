import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertWithinSpendBudget,
  clearSpendBudgetCaches,
  getSpendBudgetStatuses,
  type SpendGateDeps,
} from "./spend-budget-gate";
import { BudgetExceededError } from "./spend-budget";
import type { SpendBudgetRow } from "./spend-budget-store";

function budgetRow(overrides: Partial<SpendBudgetRow> = {}): SpendBudgetRow {
  return {
    scope: "org",
    orgId: "org-1",
    workspaceId: null,
    enabled: true,
    period: "monthly",
    windowDays: null,
    limitMicros: 10_000_000n, // $10
    id: "bdg-1",
    publicId: "bdg_abc",
    notifiedThreshold: 0,
    notifiedPeriodStart: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  };
}

/** Deps that never hit a DB/ClickHouse — every seam is injected. */
function deps(overrides: Partial<SpendGateDeps> = {}): Partial<SpendGateDeps> {
  return {
    loadBudgets: vi.fn(async () => []),
    readSpend: vi.fn(async () => 0n),
    now: () => new Date("2026-07-21T12:00:00Z").getTime(),
    claimThreshold: vi.fn(async () => true),
    notify: vi.fn(),
    ttlConfigMs: 30_000,
    ttlSpendMs: 15_000,
    ...overrides,
  };
}

const args = {
  orgId: "org-1",
  workspaceId: "ws-1",
  capability: "run_workflow",
};

beforeEach(() => clearSpendBudgetCaches());

describe("assertWithinSpendBudget — admission", () => {
  it("no configured budgets → allows without reading spend", async () => {
    const d = deps({ loadBudgets: vi.fn(async () => []) });
    await expect(assertWithinSpendBudget(args, d)).resolves.toBeUndefined();
    expect(d.readSpend).not.toHaveBeenCalled();
  });

  it("spend under the ceiling → allows", async () => {
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow()]),
      readSpend: vi.fn(async () => 4_000_000n), // $4 of $10
    });
    await expect(assertWithinSpendBudget(args, d)).resolves.toBeUndefined();
  });

  it("WITNESS: spend at/over the ceiling → denies with budget_exceeded before the provider call", async () => {
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow({ limitMicros: 10_000_000n })]),
      readSpend: vi.fn(async () => 10_000_000n), // exactly at limit → deny
    });
    const err = await assertWithinSpendBudget(args, d).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).code).toBe("budget_exceeded");
    expect((err as BudgetExceededError).capability).toBe("run_workflow");
    expect((err as BudgetExceededError).scope).toBe("org");
  });

  it("workspace ceiling denies even when the org ceiling is fine", async () => {
    const d = deps({
      loadBudgets: vi.fn(async () => [
        budgetRow({
          id: "org",
          scope: "org",
          workspaceId: null,
          limitMicros: 100_000_000n,
        }),
        budgetRow({
          id: "ws",
          scope: "workspace",
          workspaceId: "ws-1",
          limitMicros: 1_000_000n,
        }),
      ]),
      readSpend: vi.fn(async () => 2_000_000n), // $2 — under org $100, over ws $1
    });
    const err = await assertWithinSpendBudget(args, d).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as BudgetExceededError).scope).toBe("workspace");
  });
});

describe("assertWithinSpendBudget — fail open", () => {
  it("config load failure never blocks a turn", async () => {
    const d = deps({
      loadBudgets: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(assertWithinSpendBudget(args, d)).resolves.toBeUndefined();
  });

  it("spend read failure never blocks a turn (per budget)", async () => {
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow()]),
      readSpend: vi.fn(async () => {
        throw new Error("clickhouse down");
      }),
    });
    await expect(assertWithinSpendBudget(args, d)).resolves.toBeUndefined();
  });
});

describe("assertWithinSpendBudget — threshold notifications", () => {
  it("crossing a soft threshold notifies once when the watermark claim wins", async () => {
    const notify = vi.fn();
    const claimThreshold = vi.fn(async () => true);
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow({ limitMicros: 10_000_000n })]),
      readSpend: vi.fn(async () => 8_500_000n), // 85% → threshold 80
      claimThreshold,
      notify,
    });
    await assertWithinSpendBudget(args, d);
    await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget resolve
    expect(claimThreshold).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 80 }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the watermark claim loses (already notified)", async () => {
    const notify = vi.fn();
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow()]),
      readSpend: vi.fn(async () => 8_500_000n),
      claimThreshold: vi.fn(async () => false),
      notify,
    });
    await assertWithinSpendBudget(args, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(notify).not.toHaveBeenCalled();
  });

  it("under 50% never attempts a notification", async () => {
    const claimThreshold = vi.fn(async () => true);
    const d = deps({
      loadBudgets: vi.fn(async () => [budgetRow()]),
      readSpend: vi.fn(async () => 100_000n),
      claimThreshold,
    });
    await assertWithinSpendBudget(args, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(claimThreshold).not.toHaveBeenCalled();
  });
});

describe("assertWithinSpendBudget — <5ms cached path (AC: guard adds <5ms p50)", () => {
  it("second (cache-hit) call is <5ms even with a slow reader", async () => {
    // A deliberately SLOW config + spend reader stands in for a real DB /
    // ClickHouse round-trip. The first call warms both caches; the second must
    // be served entirely from the scope-keyed caches and add <5ms.
    const slow = async <T>(v: T): Promise<T> => {
      await new Promise((r) => setTimeout(r, 40));
      return v;
    };
    const d = deps({
      loadBudgets: vi.fn(() =>
        slow([budgetRow({ limitMicros: 100_000_000n })]),
      ),
      readSpend: vi.fn(() => slow(1_000_000n)),
      now: () => Date.now(), // real clock so TTL windows are honoured
      ttlConfigMs: 60_000,
      ttlSpendMs: 60_000,
    });

    await assertWithinSpendBudget(args, d); // cold — warms caches (~80ms)
    const start = performance.now();
    await assertWithinSpendBudget(args, d); // warm — cache hits only
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(5);
    // Readers were each hit exactly once (the warm call touched neither).
    expect(d.loadBudgets).toHaveBeenCalledTimes(1);
    expect(d.readSpend).toHaveBeenCalledTimes(1);
  });
});

describe("getSpendBudgetStatuses", () => {
  it("returns burn + a monthly projection per configured ceiling", async () => {
    const statuses = await getSpendBudgetStatuses({
      loadBudgets: async () => [budgetRow({ limitMicros: 10_000_000n })],
      readSpend: async () => 5_000_000n, // $5 spent
      now: () => new Date("2026-07-16T00:00:00Z").getTime(), // ~half the month
    });
    expect(statuses).toHaveLength(1);
    const s = statuses[0]!;
    expect(s.spentMicros).toBe(5_000_000n);
    expect(s.ratio).toBeCloseTo(0.5);
    // Half a 31-day month elapsed at $5 → projects to roughly the full $10 ceiling.
    expect(Number(s.projectedMicros)).toBeGreaterThan(9_000_000);
    expect(Number(s.projectedMicros)).toBeLessThan(11_000_000);
  });

  it("a spend-read failure yields spent=0 rather than throwing", async () => {
    const statuses = await getSpendBudgetStatuses({
      loadBudgets: async () => [budgetRow()],
      readSpend: async () => {
        throw new Error("clickhouse down");
      },
    });
    expect(statuses[0]!.spentMicros).toBe(0n);
    expect(statuses[0]!.state).toBe("ok");
  });
});
