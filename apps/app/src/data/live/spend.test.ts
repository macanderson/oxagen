// The spend port: each method is one kernel read of its contract on the spend
// page's failure row, mapped into the view model, with a refusal passed
// through and an unmappable record reported once.
import { billingBudgetGet } from "@oxagen/oxagen/contracts/billing.budget.get";
import { costPriceEntryList } from "@oxagen/oxagen/contracts/cost.price_entry.list";
import { costUnpricedModelList } from "@oxagen/oxagen/contracts/cost.unpriced_model.list";
import { findingEvidenceGet } from "@oxagen/oxagen/contracts/finding.evidence.get";
import { findingList } from "@oxagen/oxagen/contracts/finding.list";
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
  wsRole: "member",
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

  it("byGroup passes get_spend's open-run count through, and invents none when it is absent", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        period,
        groupBy: "model",
        total: figure,
        rows: [],
        estimatedRuns: 3,
      }),
    );
    const open = await spend.byGroup(ctx, "model", period);
    expect(open.ok && open.value.estimatedRuns).toBe(3);

    kernelRead.mockResolvedValue(
      readOk({ period, groupBy: "model", total: figure, rows: [] }),
    );
    const older = await spend.byGroup(ctx, "model", period);
    expect(older.ok).toBe(true);
    expect(older.ok ? older.value.estimatedRuns : null).toBeUndefined();
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

describe("the findings the Spend page leads with", () => {
  const savingCost = {
    micros: "984600000",
    currency: "USD",
    basis: "gateway_observed",
  };
  const listedFinding = {
    id: "fnd_01k5rtgh",
    kind: "unpaged_results",
    level: "tool",
    subject: "aws_billing__get_cost_and_usage",
    saving: savingCost,
    confidence: "high",
    window: {
      from: "2026-08-16T00:00:00.000Z",
      to: "2026-09-15T00:00:00.000Z",
    },
    why: "Each run requests thirty days of line items unpaged.",
    fix: "Request grouped totals; page line items only on drill-down.",
    runs: 88,
    calls: 3106,
    status: "open",
    detectedAt: "2026-09-15T02:00:00.000Z",
    decidedAt: null,
    appliedActionId: null,
  };

  it("findings reads list_findings over the open findings and drops the decision fields", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        status: "open",
        window: listedFinding.window,
        saving: savingCost,
        spend: null,
        share: null,
        annualised: savingCost,
        counts: { findings: 1, high: 1, medium: 0, operators: 2 },
        findings: [listedFinding],
      }),
    );
    const read = await spend.findings(ctx);
    expect(read.ok && read.value.counts.operators).toBe(2);
    expect(read.ok && read.value.findings[0]).toEqual({
      id: "fnd_01k5rtgh",
      kind: "unpaged_results",
      level: "tool",
      subject: "aws_billing__get_cost_and_usage",
      saving: savingCost,
      confidence: "high",
      window: listedFinding.window,
      why: listedFinding.why,
      fix: listedFinding.fix,
      runs: 88,
      calls: 3106,
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: findingList,
      input: { status: "open" },
      page: "spend",
    });
  });

  it("findingEvidence reads get_finding_evidence for the finding asked for", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        finding: listedFinding,
        evidence: {
          calls: 3106,
          coveredCalls: 2980,
          measuredTokens: 41200,
          counterfactualTokens: 1900,
          measured: { micros: "1030400000", currency: "USD" },
          counterfactual: { micros: "45800000", currency: "USD" },
          runs: [],
        },
      }),
    );
    const read = await spend.findingEvidence(ctx, "fnd_01k5rtgh");
    expect(read.ok && read.value.coveredCalls).toBe(2980);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: findingEvidenceGet,
      input: { findingId: "fnd_01k5rtgh" },
      page: "spend",
    });
  });

  it("priceBook reads list_price_entries at the read instant, as money in the row's currency", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        at: "2026-09-15T12:00:00.000Z",
        entries: [
          {
            id: "9f1b7a2c-0000-4000-8000-000000000001",
            orgId: null,
            provider: "anthropic",
            model: "claude-sonnet-5",
            modelAliases: [],
            region: null,
            tokenClass: "output",
            unit: "token",
            currency: "USD",
            microsPerMillion: "15000000",
            effectiveFrom: "2026-01-01T00:00:00.000Z",
            effectiveTo: null,
            source: "list",
          },
        ],
      }),
    );
    const read = await spend.priceBook(ctx);
    expect(read.ok && read.value.entries[0]).toEqual(
      expect.objectContaining({
        ratePerMillion: { micros: "15000000", currency: "USD" },
        negotiated: false,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: costPriceEntryList,
      input: { includeScheduled: true },
      page: "spend",
    });
  });

  it("unpricedModels reads list_unpriced_models over the window the contract chose", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        since: "2026-08-16T00:00:00.000Z",
        at: "2026-09-15T12:00:00.000Z",
        models: [
          {
            model: "acme-internal-7b",
            provider: "acme",
            calls: 1240,
            tokens: 9400000,
            firstSeen: "2026-08-20T00:00:00.000Z",
            lastSeen: "2026-09-15T00:00:00.000Z",
            missingClasses: ["input_uncached", "output"],
            missingClassWindows: [],
            fullyUnpriced: true,
          },
        ],
      }),
    );
    const read = await spend.unpricedModels(ctx);
    expect(read.ok && read.value.models[0]?.fullyUnpriced).toBe(true);
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: costUnpricedModelList,
      input: {},
      page: "spend",
    });
  });

  it("passes a refused price-book read through as the kernel classified it (negative)", async () => {
    kernelRead.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    expect(await spend.priceBook(ctx)).toEqual({
      ok: false,
      reason: "denied",
      permission: "spend.read",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers record_unmappable for a finding the view model refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        status: "open",
        window: listedFinding.window,
        saving: savingCost,
        spend: null,
        share: null,
        annualised: null,
        counts: { findings: 1, high: 1, medium: 0, operators: 1 },
        findings: [{ ...listedFinding, id: "01k5rtgh" }],
      }),
    );
    expect(await spend.findings(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});
