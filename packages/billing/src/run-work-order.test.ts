/**
 * The work order a run belongs to (F13, #4638): the resolver's order of
 * checks, the record the rollup writes, and the conflict update that keeps a
 * resolved work order. Every store is a fake, so no module is mocked.
 */
import type { Tx } from "@oxagen/database";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { RunMeta, RunTotalsRecord } from "./cost-rollup";
import { rebuildRunTotals, writeRunTotals, type RunRollupDeps } from "./cost-rollup-store";
import {
  resolveRunWorkOrder,
  type RunWorkOrderDeps,
  type RunWorkOrderSource,
} from "./run-work-order";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const RUN = "tse_workorder000000000001";
const AGENT = "0192d4a8-7c1e-7a00-8000-0000000a9e01";
const SEND = "0192d4a8-7c1e-7a00-8000-0000000500d1";
const OTHER_SEND = "0192d4a8-7c1e-7a00-8000-0000000500d2";
const DIRECT = "0192d4a8-7c1e-7a00-8000-0000000d1e01";

function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: RUN,
    runSource: "tacho",
    ...SCOPE,
    operatorPrincipalId: "0192d4a8-7c1e-7a00-8000-0000000b0001",
    operatorKey: "prn_operator",
    agentPrincipalId: AGENT,
    agentKey: "acme.core.bot",
    taskRef: null,
    costCenter: null,
    startedAt: new Date("2026-10-01T09:00:00.000Z"),
    sealedAt: new Date("2026-10-01T09:10:00.000Z"),
    turns: 1,
    retries: 0,
    enforcementTier: "gateway",
    replayGrade: "view",
    ...over,
  };
}

function tachoSource(over: Partial<RunMeta> = {}): RunWorkOrderSource {
  return {
    meta: meta(over),
    frames: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] },
  };
}

/** Fakes for each read and the write, with the sends a claim may name. */
function fakes(over: {
  linked?: string | null;
  claims?: string[];
  /** claim → the send it names, for the run's agent. */
  sends?: Record<string, string>;
}) {
  const opened: RunMeta[] = [];
  const deps: RunWorkOrderDeps = {
    readLinkedSend: vi.fn(async () => over.linked ?? null),
    readClaims: vi.fn(async () => over.claims ?? []),
    verifyClaim: vi.fn(async (_scope, claim, agent) =>
      agent === AGENT ? (over.sends?.[claim] ?? null) : null,
    ),
    openDirectOrder: vi.fn(async (m: RunMeta) => {
      opened.push(m);
      return DIRECT;
    }),
  };
  return { deps, opened };
}

describe("resolveRunWorkOrder", () => {
  it("takes the send a run_linked fact ties the run to, and reads no claim", async () => {
    const { deps, opened } = fakes({ linked: SEND, claims: ["wo_other"] });
    await expect(resolveRunWorkOrder(tachoSource(), deps)).resolves.toEqual({ id: SEND, kind: "send" });
    expect(deps.readLinkedSend).toHaveBeenCalledWith(SCOPE, RUN);
    expect(deps.readClaims).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });

  it("takes a claimed send that went to the run's agent in its workspace", async () => {
    const { deps, opened } = fakes({ claims: ["wo_launched"], sends: { wo_launched: SEND } });
    await expect(resolveRunWorkOrder(tachoSource(), deps)).resolves.toEqual({ id: SEND, kind: "send" });
    expect(deps.verifyClaim).toHaveBeenCalledWith(SCOPE, "wo_launched", AGENT);
    expect(opened).toEqual([]);
  });

  it("skips a claim it cannot verify and takes the next one that verifies", async () => {
    const { deps } = fakes({
      claims: ["wo_forged", "wo_launched"],
      sends: { wo_launched: OTHER_SEND },
    });
    await expect(resolveRunWorkOrder(tachoSource(), deps)).resolves.toEqual({
      id: OTHER_SEND,
      kind: "send",
    });
  });

  it("opens a direct work order when no claim verifies", async () => {
    const { deps, opened } = fakes({ claims: ["wo_forged"] });
    await expect(resolveRunWorkOrder(tachoSource(), deps)).resolves.toEqual({ id: DIRECT, kind: "direct" });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      runId: RUN,
      ...SCOPE,
      operatorPrincipalId: "0192d4a8-7c1e-7a00-8000-0000000b0001",
      agentPrincipalId: AGENT,
      startedAt: new Date("2026-10-01T09:00:00.000Z"),
    });
  });

  it("opens a direct work order for a run started outside Oxagen", async () => {
    const { deps } = fakes({});
    await expect(resolveRunWorkOrder(tachoSource(), deps)).resolves.toEqual({ id: DIRECT, kind: "direct" });
    expect(deps.readClaims).toHaveBeenCalledTimes(1);
  });

  it("reads no claim for a run with no agent principal, which cannot prove one", async () => {
    const { deps } = fakes({ claims: ["wo_launched"], sends: { wo_launched: SEND } });
    await expect(
      resolveRunWorkOrder(tachoSource({ agentPrincipalId: null }), deps),
    ).resolves.toEqual({ id: DIRECT, kind: "direct" });
    expect(deps.readClaims).not.toHaveBeenCalled();
    expect(deps.verifyClaim).not.toHaveBeenCalled();
  });

  it("propagates a failed read, so the rollup retries instead of opening a direct work order", async () => {
    const { deps, opened } = fakes({});
    deps.readClaims = vi.fn(async () => {
      throw new Error("clickhouse down");
    });
    await expect(resolveRunWorkOrder(tachoSource(), deps)).rejects.toThrow("clickhouse down");
    expect(opened).toEqual([]);
  });
});

describe("rebuildRunTotals and the run's work order", () => {
  function rollupDeps(resolve?: RunRollupDeps["resolveWorkOrder"]) {
    const written: RunTotalsRecord[] = [];
    const d: RunRollupDeps = {
      loadRunSource: async (publicId) =>
        publicId === RUN
          ? { meta: meta(), frames: { kind: "tacho", rootSessionUuid: RUN, sessionUuids: [RUN] } }
          : null,
      readModelCalls: async () => [],
      readToolCalls: async () => [],
      loadPriceBook: async () => [],
      readCarried: async () => null,
      readVerdict: async () => null,
      readWitnessedRun: async () => null,
      write: async (record) => {
        written.push(record);
      },
      now: () => new Date("2026-10-01T10:00:00.000Z"),
      ...(resolve === undefined ? {} : { resolveWorkOrder: resolve }),
    };
    return { d, written };
  }

  it("writes the send a work order launched the run under", async () => {
    const { d, written } = rollupDeps(async () => ({ id: SEND, kind: "send" }));
    const record = await rebuildRunTotals(RUN, d);
    expect(record).toMatchObject({ workOrderId: SEND, workOrderKind: "send" });
    expect(written[0]).toMatchObject({ workOrderId: SEND, workOrderKind: "send" });
  });

  it("writes the direct work order of a run started outside Oxagen", async () => {
    const { d, written } = rollupDeps(async () => ({ id: DIRECT, kind: "direct" }));
    await rebuildRunTotals(RUN, d);
    expect(written[0]).toMatchObject({ workOrderId: DIRECT, workOrderKind: "direct" });
  });

  it("resolves no work order when the deps carry no resolver", async () => {
    const { d, written } = rollupDeps();
    await rebuildRunTotals(RUN, d);
    expect(written[0]?.workOrderId ?? null).toBeNull();
  });
});

describe("writeRunTotals and the run's work order", () => {
  type Written = { values: Record<string, unknown>; set: Record<string, unknown> };

  function recordingTx(): { tx: Tx; written: Written[] } {
    const written: Written[] = [];
    const tx = {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (config: { set: Record<string, unknown> }) => {
            written.push({ values, set: config.set });
            return Promise.resolve();
          },
        }),
      }),
    };
    return { tx: tx as unknown as Tx, written };
  }

  const record: RunTotalsRecord = {
    ...meta(),
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    tokens: {
      input_uncached: 0,
      cache_read: 0,
      cache_write_5m: 0,
      cache_write_1h: 0,
      output: 0,
      reasoning: 0,
      server_tool_request: 0,
    },
    costMicros: null,
    currency: "USD",
    costBasis: null,
    priceEntryIds: [],
    cacheHitRate: null,
    breakdown: { models: [], tools: [], steps: null },
    verdict: null,
    accepted: null,
    productiveRatio: null,
    advancedSteps: null,
    unproductiveSteps: null,
  };

  it("inserts the work order and its kind", async () => {
    const { tx, written } = recordingTx();
    await writeRunTotals(tx, { ...record, workOrderId: SEND, workOrderKind: "send" }, new Date());
    expect(written[0]?.values).toMatchObject({ workOrderId: SEND, workOrderKind: "send" });
  });

  it("inserts null for a record with no work order", async () => {
    const { tx, written } = recordingTx();
    await writeRunTotals(tx, record, new Date());
    expect(written[0]?.values).toMatchObject({ workOrderId: null, workOrderKind: null });
  });

  it("keeps the row's work order on a rebuild that resolved none, and moves the pair together", async () => {
    const { tx, written } = recordingTx();
    await writeRunTotals(tx, record, new Date());
    const set = written[0]?.set ?? {};
    const render = (fragment: unknown) =>
      new PgDialect().sqlToQuery(fragment as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
    // The excluded row comes first, so a resolved id replaces the stored one
    // and a null keeps it.
    expect(render(set.workOrderId)).toBe(
      'coalesce(excluded.work_order_id, "cost"."run_totals"."work_order_id")',
    );
    expect(render(set.workOrderKind)).toBe(
      'case when excluded.work_order_id is null then "cost"."run_totals"."work_order_kind" else excluded.work_order_kind end',
    );
  });
});
