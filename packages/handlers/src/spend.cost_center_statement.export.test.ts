import {
  COST_CENTER_STATEMENT_COLUMNS,
  spendCostCenterStatementExport,
} from "@oxagen/oxagen/contracts/spend.cost_center_statement.export";
import {
  dailyTotalsFromRuns,
  UNASSIGNED_COST_CENTER_KEY,
  type RunTotalsRecord,
} from "@oxagen/billing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCostCenterStatementHandler } from "./spend.cost_center_statement.export";
import { ctx, pricedRun, run, SCOPE } from "./spend.test-support";

// The org-role gate (INV-29). Allows by default, an org Billing member, so each
// case tests its own behaviour. The refusal case sets `roleGate.refuse`.
const roleGate = vi.hoisted(() => ({
  refuse: false,
  assertOrgRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => ({
  resolveActingUserId: async (c: { userId?: string | null }) =>
    c.userId ?? null,
  assertOrgRole: roleGate.assertOrgRole.mockImplementation(async () => {
    if (roleGate.refuse) {
      throw Object.assign(new Error("forbidden: org role required"), {
        code: "forbidden",
      });
    }
    return "Billing";
  }),
}));

beforeEach(() => {
  roleGate.refuse = false;
  roleGate.assertOrgRole.mockClear();
});

// The fixture organization (ADR-142): two workspaces, three agents, two cost
// centers. `alpha` names ENG-1001 itself. `beta` names none and sits in the
// core workspace, which is charged to MKT-2002, so the workspace's label
// applies. `gamma` sits in the lab workspace, which names none, so its spend
// is unassigned. The rollup store resolves that precedence into each run's
// `costCenter`; the runs below carry what it resolved.
const LAB = "0192d4a8-7c1e-7a00-8000-0000000c0e02";
const ENG = "ENG-1001";
const MKT = "MKT-2002";

const fixtureRuns: RunTotalsRecord[] = [
  pricedRun(1_234_567n, {
    agentKey: "acme.core.alpha",
    costCenter: ENG,
    costBasis: "gateway_observed",
    startedAt: new Date("2026-09-02T09:00:00.000Z"),
  }),
  pricedRun(2_000_005n, {
    agentKey: "acme.core.alpha",
    costCenter: ENG,
    costBasis: "client_attested",
    startedAt: new Date("2026-09-03T09:00:00.000Z"),
  }),
  pricedRun(3_333_333n, {
    agentKey: "acme.core.beta",
    costCenter: MKT,
    startedAt: new Date("2026-09-04T09:00:00.000Z"),
  }),
  // A run no frame priced: counted and listed on its line, adding no cost.
  run({
    agentKey: "acme.core.beta",
    costCenter: MKT,
    startedAt: new Date("2026-09-05T09:00:00.000Z"),
  }),
  pricedRun(777_777n, {
    workspaceId: LAB,
    agentKey: "acme.lab.gamma",
    costCenter: null,
    startedAt: new Date("2026-09-06T09:00:00.000Z"),
  }),
];

function harness(runs: RunTotalsRecord[]) {
  const readRunTotals = vi.fn(
    async (_orgId: string, q: { from: string; to: string }) =>
      runs.filter((r) => {
        const day = r.startedAt.toISOString().slice(0, 10);
        return day >= q.from && day <= q.to;
      }),
  );
  return {
    handler: createCostCenterStatementHandler({ readRunTotals }),
    readRunTotals,
  };
}

const exported = async (runs = fixtureRuns) => {
  const { handler } = harness(runs);
  return spendCostCenterStatementExport.output.parse(
    await handler({ month: "2026-09", format: "csv" }, ctx()),
  );
};

const orgTotal = fixtureRuns.reduce((sum, r) => sum + (r.costMicros ?? 0n), 0n);

describe("export_cost_center_statement", () => {
  it("refuses a member outside Owner, Admin and Billing before reading any run", async () => {
    roleGate.refuse = true;
    const { handler, readRunTotals } = harness(fixtureRuns);
    await expect(
      handler({ month: "2026-09", format: "csv" }, ctx()),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(roleGate.assertOrgRole).toHaveBeenCalledWith(expect.anything(), {
      org: ["Owner", "Admin", "Billing"],
    });
    expect(readRunTotals).not.toHaveBeenCalled();
  });

  it("answers per-center totals that sum to the organization total", async () => {
    const out = await exported();
    const lineSum = out.lines.reduce(
      (sum, l) => sum + (l.cost === null ? 0n : BigInt(l.cost.micros)),
      0n,
    );
    expect(BigInt(out.total.cost!.micros)).toBe(orgTotal);
    expect(lineSum).toBe(orgTotal);
    expect(out.lines.reduce((n, l) => n + l.runs, 0)).toBe(out.total.runs);
    expect(out.total.runs).toBe(fixtureRuns.length);
  });

  it("puts each run on one line, the unassigned share as its own line", async () => {
    const out = await exported();
    expect(out.lines.map((l) => l.costCenter)).toEqual([
      MKT,
      ENG,
      UNASSIGNED_COST_CENTER_KEY,
    ]);
    const ids = out.lines.flatMap((l) => l.runIds);
    expect(ids.sort()).toEqual(fixtureRuns.map((r) => r.runId).sort());
    const none = out.lines.at(-1)!;
    expect(none.runIds).toEqual([fixtureRuns[4]!.runId]);
    expect(none.cost!.micros).toBe("777777");
  });

  it("gives every priced figure a basis and counts the runs it could not price", async () => {
    const out = await exported();
    for (const figure of [...out.lines.map((l) => l.cost), out.total.cost]) {
      expect(figure).not.toBeNull();
      expect(figure!.basis).toBeDefined();
    }
    const eng = out.lines.find((l) => l.costCenter === ENG)!;
    expect(eng.cost!.basis).toBe("mixed");
    const mkt = out.lines.find((l) => l.costCenter === MKT)!;
    expect(mkt.runs).toBe(2);
    expect(mkt.unpricedRuns).toBe(1);
    expect(out.total.unpricedRuns).toBe(1);
  });

  it("writes the same figures to the CSV, with the run ids on each line", async () => {
    const out = await exported();
    const [header, ...rows] = out.content.trimEnd().split("\n");
    expect(header).toBe(COST_CENTER_STATEMENT_COLUMNS.join(","));
    const cells = rows.map((r) => r.split(","));
    const micros = COST_CENTER_STATEMENT_COLUMNS.indexOf("cost_micros");
    const runIds = COST_CENTER_STATEMENT_COLUMNS.indexOf("run_ids");
    const centerRows = cells.filter((c) => c[0] === "cost_center");
    const totalRow = cells.find((c) => c[0] === "total")!;
    expect(centerRows.reduce((sum, c) => sum + BigInt(c[micros]!), 0n)).toBe(
      BigInt(totalRow[micros]!),
    );
    expect(centerRows.map((c) => c[runIds]!.split(" ").length)).toEqual(
      out.lines.map((l) => l.runIds.length),
    );
    // 1_234_567 + 2_000_005 micros is 323.4572 cents: rounded once, half to even.
    const eng = centerRows.find((c) => c[1] === ENG)!;
    expect(eng[COST_CENTER_STATEMENT_COLUMNS.indexOf("cost_cents")]).toBe(
      "323",
    );
  });

  it("reconciles with the Spend page's cost_center level over the same runs", async () => {
    const out = await exported();
    const level = dailyTotalsFromRuns(fixtureRuns).filter(
      (r) => r.groupKind === "cost_center",
    );
    const levelSum = level.reduce((sum, r) => sum + (r.costMicros ?? 0n), 0n);
    expect(levelSum).toBe(BigInt(out.total.cost!.micros));
  });

  it("reads the organization's month and nothing outside it", async () => {
    const { handler, readRunTotals } = harness([
      ...fixtureRuns,
      pricedRun(9n, { startedAt: new Date("2026-10-01T00:00:00.000Z") }),
    ]);
    const out = await handler({ month: "2026-09", format: "csv" }, ctx());
    expect(readRunTotals).toHaveBeenCalledWith(SCOPE.orgId, {
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(BigInt(out.total.cost!.micros)).toBe(orgTotal);
  });

  it("answers an empty month with no lines and no fabricated zero", async () => {
    const out = await exported([]);
    expect(out.lines).toEqual([]);
    expect(out.total).toEqual({ runs: 0, unpricedRuns: 0, cost: null });
  });
});
