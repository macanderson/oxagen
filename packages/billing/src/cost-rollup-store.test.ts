/**
 * Unit tests for `rebuildRunTotals` (ADR-060, ADR-064): the run's verdict comes
 * from its verdict rows on every rebuild, and a witness run's row names the
 * operator of the worker run it reported on. Every store is a fake that
 * records what it was asked; the verdict and witness-link queries run against
 * Postgres in packages/handlers/src/lib/proof.pg.test.ts.
 */
import { schema } from "@oxagen/database";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  ZERO_TOKENS,
  type ModelCallFrame,
  type RunMeta,
  type RunTotalsRecord,
} from "./cost-rollup";
import {
  modelCallHidesTurn,
  rebuildRunTotals,
  reviveBreakdown,
  serializeBreakdown,
  toolCallName,
  type RunRollupDeps,
} from "./cost-rollup-store";

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
  modelCalls?: ModelCallFrame[];
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
    readModelCalls: async () => over.modelCalls ?? [],
    readToolCalls: async () => [],
    loadPriceBook: vi.fn(async () => []),
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

describe("an in-app assistant run (#4167)", () => {
  const RUN = "arun_0123456789abcdef012345";
  const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000a0001";
  const MESSAGE = "0192d4a8-7c1e-7a00-8000-0000000a0002";

  it("prices the model calls the turn metered on the message that asked for it", async () => {
    const { d, written } = deps({ runs: {} });
    d.loadRunSource = async () => ({
      meta: {
        ...meta(RUN, "prn_asker"),
        runSource: "ledger",
        enforcementTier: null,
        replayGrade: null,
      },
      frames: { kind: "ledger", runUuid: RUN_UUID, originMessageId: MESSAGE },
    });
    // `token_usage` holds the turn's calls under the message id, as the
    // assistant writes them: a read on the run's uuid alone finds none.
    const readModelCalls = vi.fn<RunRollupDeps["readModelCalls"]>(
      async ({ run }) =>
        run.kind === "ledger" && run.originMessageId === MESSAGE
          ? [
              {
                at: new Date("2026-09-15T09:05:00.000Z"),
                model: "claude-sonnet-5",
                provider: "anthropic",
                tokens: {
                  input_uncached: 1000,
                  cache_read: 0,
                  cache_write_5m: 0,
                  cache_write_1h: 0,
                  output: 100,
                  reasoning: 0,
                  server_tool_request: 0,
                },
                reportedCostMicros: 4500n,
                basis: "gateway_observed",
              },
            ]
          : [],
    );
    d.readModelCalls = readModelCalls;
    d.loadPriceBook = async () => [
      {
        id: "pe_in",
        orgId: null,
        provider: "anthropic",
        model: "claude-sonnet-5",
        modelAliases: [],
        region: null,
        tokenClass: "input_uncached",
        unit: "token",
        currency: "USD",
        microsPerMillion: 3_000_000n,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        source: "list",
      },
      {
        id: "pe_out",
        orgId: null,
        provider: "anthropic",
        model: "claude-sonnet-5",
        modelAliases: [],
        region: null,
        tokenClass: "output",
        unit: "token",
        currency: "USD",
        microsPerMillion: 15_000_000n,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        effectiveTo: null,
        source: "list",
      },
    ];

    const record = await rebuildRunTotals(RUN, d);

    expect(readModelCalls).toHaveBeenCalledWith({
      ...SCOPE,
      run: { kind: "ledger", runUuid: RUN_UUID, originMessageId: MESSAGE },
    });
    // 1000 input at $3 and 100 output at $15 a million: $0.0045.
    expect(record?.costMicros).toBe(4500n);
    expect(record?.costBasis).toBe("gateway_observed");
    expect(record?.modelCalls).toBe(1);
    expect(record?.breakdown.models.map((m) => m.model)).toEqual([
      "claude-sonnet-5",
    ]);
    expect(written).toHaveLength(1);
  });
});

describe("what a ledger run's events are read for (#3372)", () => {
  const render = (fragment: Parameters<PgDialect["sqlToQuery"]>[0]) =>
    new PgDialect().sqlToQuery(fragment).sql;
  const PAYLOAD = '"agent"."agent_run_events"."payload_inline"';

  it("names an assistant tool call by `tool_name` when it has no `capability_name`", () => {
    // `tool.engine_call_completed` stores its name in `tool_name`. Reading
    // `capability_name` alone counted the call in `toolCalls` and left it
    // out of `breakdown.tools`.
    expect(render(toolCallName(schema.agentRunEvents.payloadInline))).toBe(
      `coalesce(${PAYLOAD}->>'capability_name', ${PAYLOAD}->>'tool_name')`,
    );
  });

  it("counts a model call with no turn index as hiding the turn count", () => {
    // An engine call's payload is inline and names no `turn_index`, so a
    // null-payload test alone reported `turns: 0` where the seal's rollup
    // records `null`.
    expect(
      render(modelCallHidesTurn(schema.agentRunEvents.payloadInline)),
    ).toBe(`(${PAYLOAD} is null or ${PAYLOAD}->>'turn_index' is null)`);
  });
});

describe("the price rows a rollup loads (#4202)", () => {
  // The rollup loaded the whole price book, 28,246 rows in production, for
  // every run it priced, and four or five of those steps at once ran the API
  // out of heap. It must ask only for the run's models over the run's span.
  const call = (at: string, model: string): ModelCallFrame => ({
    at: new Date(at),
    model,
    provider: "anthropic",
    tokens: { ...ZERO_TOKENS, input_uncached: 10, output: 5 },
    reportedCostMicros: null,
    basis: "client_attested",
  });

  it("asks for the run's distinct models from its first call to its last", async () => {
    const { d } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      modelCalls: [
        call("2026-09-24T17:05:00.000Z", "claude-sonnet-5"),
        call("2026-09-24T16:55:00.000Z", "anthropic/claude-haiku-4.5"),
        call("2026-09-24T17:40:00.000Z", "claude-sonnet-5"),
      ],
    });

    await rebuildRunTotals(WORKER, d);

    expect(d.loadPriceBook).toHaveBeenCalledTimes(1);
    expect(d.loadPriceBook).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      models: ["claude-sonnet-5", "anthropic/claude-haiku-4.5"],
      from: new Date("2026-09-24T16:55:00.000Z"),
      to: new Date("2026-09-24T17:40:00.000Z"),
    });
  });

  it("asks for no models when the run made no model call, and still writes its row", async () => {
    const { d, written } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
    });

    await rebuildRunTotals(WORKER, d);

    expect(d.loadPriceBook).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: SCOPE.orgId, models: [] }),
    );
    expect(written).toHaveLength(1);
  });
});

describe("the breakdown jsonb (#4069)", () => {
  const byClass = {
    input_uncached: 3_000n,
    cache_read: 300n,
    cache_write_5m: 0n,
    cache_write_1h: 0n,
    output: 1_500n,
    reasoning: 0n,
    server_tool_request: 0n,
  };
  const breakdown: RunTotalsRecord["breakdown"] = {
    models: [
      {
        model: "claude-sonnet-5",
        provider: "anthropic",
        calls: 2,
        tokens: {
          input_uncached: 1_000,
          cache_read: 1_000,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 100,
          reasoning: 0,
          server_tool_request: 0,
        },
        costMicros: 4_800n,
        costByClass: byClass,
        cacheSavingMicros: 2_700n,
        basis: "gateway_observed",
        hasUnpriced: false,
      },
      {
        model: "mystery-9",
        provider: null,
        calls: 1,
        tokens: {
          input_uncached: 0,
          cache_read: 10,
          cache_write_5m: 0,
          cache_write_1h: 0,
          output: 0,
          reasoning: 0,
          server_tool_request: 0,
        },
        costMicros: null,
        costByClass: {
          ...byClass,
          input_uncached: 0n,
          cache_read: 0n,
          output: 0n,
        },
        cacheSavingMicros: null,
        basis: null,
        hasUnpriced: true,
      },
    ],
    tools: [{ name: "Read", calls: 1 }],
  };

  /** What jsonb hands back: the serialised value through JSON text. */
  const throughJsonb = (value: unknown) => JSON.parse(JSON.stringify(value));

  it("writes the saving as a decimal string and reads it back as the same bigint or null", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    expect(stored.models[0].cacheSavingMicros).toBe("2700");
    expect(stored.models[1].cacheSavingMicros).toBeNull();
    expect(reviveBreakdown(stored)).toEqual(breakdown);
  });

  it("reads a row rolled up before the saving existed as not recorded, never as 0", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    for (const m of stored.models) delete m.cacheSavingMicros;
    const revived = reviveBreakdown(stored);
    expect(revived.models.map((m) => m.cacheSavingMicros)).toEqual([
      null,
      null,
    ]);
    // Everything else the legacy row carried reads as before.
    expect(revived.models[0]!.costByClass).toEqual(byClass);
    expect(revived.models[0]!.costMicros).toBe(4_800n);
  });

  it("reads a row rolled up before server_tool_request existed as zero requests and zero cost (#3721)", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    for (const m of stored.models) {
      delete m.tokens.server_tool_request;
      delete m.costByClass.server_tool_request;
    }
    const revived = reviveBreakdown(stored);
    expect(revived.models.map((m) => m.tokens.server_tool_request)).toEqual([
      0, 0,
    ]);
    expect(
      revived.models.map((m) => m.costByClass.server_tool_request),
    ).toEqual([0n, 0n]);
    // The legacy row reads back whole, as the rollup would write it now.
    expect(revived).toEqual(breakdown);
  });
});
