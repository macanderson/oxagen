/**
 * Unit tests for `rebuildRunTotals` (ADR-060, ADR-064): the run's verdict comes
 * from its verdict rows on every rebuild, and a witness run's row names the
 * operator of the worker run it reported on. Every store is a fake that
 * records what it was asked; the verdict and witness-link queries run against
 * Postgres in packages/handlers/src/lib/proof.pg.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { RunMeta, RunTotalsRecord } from "./cost-rollup";
import { rebuildRunTotals, type RunRollupDeps } from "./cost-rollup-store";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const WORKER = "tse_worker0000000000000001";
const WITNESS = "tse_witness000000000000001";

function meta(runId: string, operator: string): RunMeta {
  return {
    runId,
    runSource: "tacho",
    ...SCOPE,
    operatorPrincipalId: `0192d4a8-7c1e-7a00-8000-0000000${operator.length}0001`,
    operatorKey: operator,
    agentPrincipalId: null,
    agentKey: "acme.core.bot",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-09-15T09:00:00.000Z"),
    sealedAt: new Date("2026-09-15T09:10:00.000Z"),
    turns: 1,
    retries: 0,
    enforcementTier: "gateway",
    replayGrade: "view",
  };
}

function deps(over: {
  runs: Record<string, RunMeta>;
  verdict?: RunTotalsRecord["verdict"];
  witnessed?: Record<string, string>;
}) {
  const written: RunTotalsRecord[] = [];
  const scopes: unknown[] = [];
  const d: RunRollupDeps = {
    loadRunSource: async (publicId) => {
      const m = over.runs[publicId];
      return m
        ? { meta: m, frames: { kind: "tacho", rootSessionUuid: publicId } }
        : null;
    },
    readModelCalls: async () => [],
    readToolCalls: async () => [],
    loadPriceBook: async () => [],
    readCarried: async () => ({ accepted: null, productiveRatio: 0.5 }),
    readVerdict: vi.fn(async (scope) => {
      scopes.push(scope);
      return over.verdict ?? null;
    }),
    readWitnessedRun: vi.fn(async (scope, runId) => {
      scopes.push(scope);
      return over.witnessed?.[runId] ?? null;
    }),
    write: async (record) => {
      written.push(record);
    },
    now: () => new Date("2026-09-15T10:00:00.000Z"),
  };
  return { d, written, scopes };
}

describe("rebuildRunTotals", () => {
  it("writes the verdict the run's verdict rows aggregate to, beside the carried value columns", async () => {
    const { d, written, scopes } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      verdict: "tampered",
    });
    const record = await rebuildRunTotals(WORKER, d);
    expect(record?.verdict).toBe("tampered");
    expect(record?.productiveRatio).toBe(0.5);
    expect(written).toHaveLength(1);
    expect(d.readVerdict).toHaveBeenCalledWith(SCOPE, WORKER);
    expect(
      scopes.every((s) => JSON.stringify(s) === JSON.stringify(SCOPE)),
    ).toBe(true);
  });

  it("attributes a witness run to the operator of the worker run it reported on", async () => {
    const { d } = deps({
      runs: {
        [WORKER]: meta(WORKER, "prn_worker_operator"),
        [WITNESS]: meta(WITNESS, "prn_runner_host"),
      },
      witnessed: { [WITNESS]: WORKER },
    });
    const record = await rebuildRunTotals(WITNESS, d);
    expect(record?.operatorKey).toBe("prn_worker_operator");
    expect(record?.operatorPrincipalId).toBe(
      meta(WORKER, "prn_worker_operator").operatorPrincipalId,
    );
    // The row stays the witness run's own: its id, agent and verdict.
    expect(record?.runId).toBe(WITNESS);
    expect(record?.verdict).toBeNull();
    expect(d.readWitnessedRun).toHaveBeenCalledWith(SCOPE, WITNESS);
  });

  it("keeps a run's own operator when no verdict names it as a witness run (negative)", async () => {
    const { d } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
    });
    expect((await rebuildRunTotals(WORKER, d))?.operatorKey).toBe(
      "prn_worker_operator",
    );
  });

  it("keeps the witness run's own operator when the worker run is not on record (negative)", async () => {
    const { d } = deps({
      runs: { [WITNESS]: meta(WITNESS, "prn_runner_host") },
      witnessed: { [WITNESS]: WORKER },
    });
    expect((await rebuildRunTotals(WITNESS, d))?.operatorKey).toBe(
      "prn_runner_host",
    );
  });
});
