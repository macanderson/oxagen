// The spend port: each method is one kernel read of its contract on the spend
// page's failure row, mapped into the view model, with a refusal passed
// through and an unmappable record reported once.
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { spendDrill } from "@oxagen/oxagen/contracts/spend.drill";
import { spendGet } from "@oxagen/oxagen/contracts/spend.get";
import { spendWasteList } from "@oxagen/oxagen/contracts/spend.waste";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { spend } = await import("./spend");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
});

const period = { from: "2026-09-01", to: "2026-09-15" };
const figure = {
  cost: { micros: "12345678", currency: "USD", basis: "gateway_observed" },
  calls: 40,
  runs: 12,
  proven: null,
  accepted: null,
  productiveRatio: null,
};

beforeEach(() => {
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("spend port", () => {
  it("byGroup reads get_spend at the level asked for", async () => {
    kernelRead.mockResolvedValue(
      readOk({ period, groupBy: "operator", total: figure, rows: [] }),
    );
    expect(await spend.byGroup(ctx, "operator", period)).toEqual(
      readOk({ period, total: figure, rows: [] }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: spendGet,
      input: { period, groupBy: "operator" },
      page: "spend",
    });
  });

  it("fleet reads get_spend at the model level over the day asked for", async () => {
    const day = { from: "2026-09-15", to: "2026-09-15" };
    kernelRead.mockResolvedValue(
      readOk({ period: day, groupBy: "model", total: figure, rows: [] }),
    );
    expect(await spend.fleet(ctx, day)).toEqual(
      readOk({ period: day, spend: figure.cost, cacheHitRate: null }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: spendGet,
      input: { period: day, groupBy: "model" },
      page: "spend",
    });
  });

  it("drill reads get_spend_drill for the key over its default window", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        kind: "agent",
        key: "acme/core-platform/triage",
        period,
        total: figure,
        series: [],
        averages: { perCall: null, perRun: null },
        share: null,
        byTool: [],
      }),
    );
    const read = await spend.drill(ctx, "agent", "acme/core-platform/triage");
    expect(read.ok && read.value.key).toBe("acme/core-platform/triage");
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: spendDrill,
      input: { kind: "agent", key: "acme/core-platform/triage" },
      page: "spend",
    });
  });

  it("waste reads list_waste and budgets reads get_spend_budget", async () => {
    kernelRead.mockImplementation(
      (_ctx: unknown, call: { contract: unknown }) =>
        Promise.resolve(
          call.contract === spendWasteList
            ? readOk({
                period,
                wasted: null,
                share: null,
                runsWithWaste: 0,
                largestCause: null,
                causes: [],
              })
            : readOk({ budgets: [] }),
        ),
    );
    expect((await spend.waste(ctx, period)).ok).toBe(true);
    expect(await spend.budgets(ctx)).toEqual(readOk([]));
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: spendWasteList,
      input: { period },
      page: "spend",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: billingBudgetGet,
      input: {},
      page: "spend",
    });
  });

  it("passes a refusal through as the kernel classified it (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "spend.read" };
    kernelRead.mockResolvedValue(denied);
    expect(await spend.byGroup(ctx, "tool", period)).toEqual(denied);
    const down = readError("rollup_rebuild_in_progress", 504);
    kernelRead.mockResolvedValue(down);
    expect(await spend.budgets(ctx)).toEqual(down);
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable and reports once for a record the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        period,
        groupBy: "operator",
        total: { ...figure, cost: { micros: "1.5", currency: "USD" } },
        rows: [],
      }),
    );
    expect(await spend.byGroup(ctx, "operator", period)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
