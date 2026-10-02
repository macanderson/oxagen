/**
 * Unit tests for `rebuildRunTotals` (ADR-060, ADR-064): the run's verdict comes
 * from its verdict rows on every rebuild, and a witness run's row names the
 * operator of the worker run it reported on. Every store is a fake that
 * records what it was asked; the verdict and witness-link queries run against
 * Postgres in packages/handlers/src/lib/proof.pg.test.ts.
 */
import { schema } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  ZERO_TOKENS,
  type RunMeta,
  type RunTotalsRecord,
  type ToolCallFrame,
} from "./cost-rollup";
import { PriceBookSliceLimitError } from "./price-book";
import {
  inAppRunTotal,
  ledgerToolStatus,
  modelCallHidesTurn,
  rebuildRunTotals,
  reviveBreakdown,
  serializeBreakdown,
  toolCallName,
  type PricedModelCall,
  type RunRollupDeps,
  type RunTokenSources,
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
  modelCalls?: PricedModelCall[];
  toolCalls?: ToolCallFrame[];
}) {
  const written: RunTotalsRecord[] = [];
  const sourcesWritten: (RunTokenSources | undefined)[] = [];
  const scopes: unknown[] = [];
  const d: RunRollupDeps = {
    loadRunSource: async (publicId) => {
      const m = over.runs[publicId];
      return m
        ? {
            meta: m,
            frames: {
              kind: "tacho",
              rootSessionUuid: publicId,
              sessionUuids: [publicId],
            },
          }
        : null;
    },
    readModelCalls: async () => over.modelCalls ?? [],
    readToolCalls: async () => over.toolCalls ?? [],
    loadPriceBook: vi.fn(async () => []),
    readCarried: async () => ({ accepted: true }),
    readVerdict: vi.fn(async (scope) => {
      scopes.push(scope);
      return over.verdict ?? null;
    }),
    readWitnessedRun: vi.fn(async (scope, runId) => {
      scopes.push(scope);
      return over.witnessed?.[runId] ?? null;
    }),
    write: async (record, _rolledUpAt, sources) => {
      written.push(record);
      sourcesWritten.push(sources);
    },
    now: () => new Date("2026-09-15T10:00:00.000Z"),
  };
  return { d, written, sourcesWritten, scopes };
}

describe("rebuildRunTotals", () => {
  it("writes the verdict the run's verdict rows aggregate to, beside the carried acceptance", async () => {
    const { d, written, scopes } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      verdict: "tampered",
    });
    const record = await rebuildRunTotals(WORKER, d);
    expect(record?.verdict).toBe("tampered");
    expect(record?.accepted).toBe(true);
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

  it("grades the steps it read and computes the productive ratio from them, never from the row (#3984)", async () => {
    const call = (over: Partial<ToolCallFrame>): ToolCallFrame => ({
      name: "Read",
      status: "ok",
      inputDigest: "sha256:in",
      outputDigest: "sha256:out",
      isMutating: false,
      resultTokens: null,
      ...over,
    });
    const { d } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      toolCalls: [
        call({ inputDigest: "sha256:a" }),
        call({ inputDigest: "sha256:a" }),
        call({ inputDigest: "sha256:b", status: "error" }),
        call({ inputDigest: "sha256:c" }),
      ],
    });
    const record = await rebuildRunTotals(WORKER, d);
    expect(record?.steps).toBe(4);
    expect(record?.advancedSteps).toBe(2);
    expect(record?.unproductiveSteps).toBe(2);
    expect(record?.breakdown.steps).toEqual({
      failed: 1,
      repeated: 1,
      retried: 0,
    });
    expect(record?.productiveRatio).toBe(0.5);
  });

  it("reads the run's file change into the step classes (F17)", async () => {
    const read: ToolCallFrame = {
      name: "Read",
      status: "ok",
      inputDigest: "sha256:in",
      outputDigest: "sha256:out",
      isMutating: false,
      resultTokens: null,
    };
    const runs = { [WORKER]: meta(WORKER, "prn_worker_operator") };
    const unchanged = deps({ runs, toolCalls: [read] });
    expect(
      (await rebuildRunTotals(WORKER, unchanged.d))?.breakdown.stepClasses,
    ).toEqual({ readOnly: 1, edit: 0 });

    const changed = deps({ runs, toolCalls: [read] });
    const readFileChanged = vi.fn(async () => true);
    changed.d.readFileChanged = readFileChanged;
    const record = await rebuildRunTotals(WORKER, changed.d);
    // No call may have written, so no step can hold the change.
    expect(record?.breakdown.stepClasses).toEqual({ readOnly: 0, edit: 1 });
    expect(readFileChanged).toHaveBeenCalledWith(
      expect.objectContaining({ meta: runs[WORKER] }),
    );
    expect(changed.written[0]?.breakdown.stepClasses).toEqual({
      readOnly: 0,
      edit: 1,
    });
  });

  it("answers no ratio for a run with no step, whatever the row held before", async () => {
    const { d } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
    });
    const record = await rebuildRunTotals(WORKER, d);
    expect(record?.productiveRatio).toBeNull();
    expect(record?.advancedSteps).toBeNull();
    expect(record?.unproductiveSteps).toBeNull();
    expect(record?.breakdown.steps).toBeNull();
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

describe("the token sources a rollup writes (#4493)", () => {
  /** A priced call at `at`, with the sources the recorder measured on it. */
  const measured = (
    at: string,
    sources?: RunTokenSources,
  ): PricedModelCall => ({
    at: new Date(at),
    model: "claude-sonnet-5",
    provider: "anthropic",
    tokens: { ...ZERO_TOKENS, input_uncached: 10, output: 5 },
    reportedCostMicros: null,
    basis: "client_attested",
    ...(sources === undefined ? {} : { sources }),
  });

  it("sums the sources over the same calls the row prices", async () => {
    const { d, written, sourcesWritten } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      modelCalls: [
        measured("2026-09-15T09:01:00.000Z", {
          toolDefinitionTokens: 12_000,
          contextFrameTokens: null,
          steeringTokens: 500,
        }),
        measured("2026-09-15T09:02:00.000Z", {
          toolDefinitionTokens: 400,
          contextFrameTokens: null,
          steeringTokens: 400,
        }),
        // A call the proxy did not see carries no sources and adds nothing.
        measured("2026-09-15T09:03:00.000Z"),
      ],
    });
    await rebuildRunTotals(WORKER, d);
    // The sums and the call count come from one read, so they agree.
    expect(written[0]?.modelCalls).toBe(3);
    // A source no call measured stays null beside the two that were.
    expect(sourcesWritten).toEqual([
      {
        toolDefinitionTokens: 12_400,
        contextFrameTokens: null,
        steeringTokens: 900,
      },
    ]);
  });

  it("sums a measured zero as zero, apart from an unmeasured source", async () => {
    const { d, sourcesWritten } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      modelCalls: [
        measured("2026-09-15T09:01:00.000Z", {
          toolDefinitionTokens: 0,
          contextFrameTokens: null,
          steeringTokens: null,
        }),
      ],
    });
    await rebuildRunTotals(WORKER, d);
    expect(sourcesWritten).toEqual([
      {
        toolDefinitionTokens: 0,
        contextFrameTokens: null,
        steeringTokens: null,
      },
    ]);
  });

  it("writes every source as null when no call measured any", async () => {
    const { d, sourcesWritten } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
    });
    await rebuildRunTotals(WORKER, d);
    expect(sourcesWritten).toEqual([
      {
        toolDefinitionTokens: null,
        contextFrameTokens: null,
        steeringTokens: null,
      },
    ]);
  });

  // #4572 item 2: the row kept each source's sum alone, so a reader took one
  // call's share as the average, and 0, 100, 100, 100 read 225 re-sent. The
  // rollup now keeps the tokens on the calls after the first.
  it("keeps each source's tokens on the calls after the first, whatever the first held", async () => {
    const tools = (n: number): RunTokenSources => ({
      toolDefinitionTokens: n,
      contextFrameTokens: null,
      steeringTokens: null,
    });
    const { d, written } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      modelCalls: [
        measured("2026-09-15T09:01:00.000Z", tools(0)),
        measured("2026-09-15T09:02:00.000Z", tools(100)),
        measured("2026-09-15T09:03:00.000Z", tools(100)),
        measured("2026-09-15T09:04:00.000Z", tools(100)),
      ],
    });
    await rebuildRunTotals(WORKER, d);
    expect(written[0]?.breakdown.standing).toEqual({
      toolDefinitionTokens: { cached: 0, uncached: 300 },
      contextFrameTokens: null,
      steeringTokens: null,
    });
  });

  // #4572 item 3: one sum over hit and miss calls priced every re-sent token
  // at the read rate. The split keeps each call's tokens on the side of its
  // own cache use.
  it("splits each call's tokens by whether the call read the cache", async () => {
    const hit = (at: string): PricedModelCall => ({
      ...measured(at, {
        toolDefinitionTokens: 100,
        contextFrameTokens: null,
        steeringTokens: 40,
      }),
      tokens: { ...ZERO_TOKENS, cache_read: 900, input_uncached: 10 },
    });
    const { d, written } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
      modelCalls: [
        // The first call sent the prefix first, so none of it is re-sent.
        hit("2026-09-15T09:01:00.000Z"),
        hit("2026-09-15T09:02:00.000Z"),
        measured("2026-09-15T09:03:00.000Z", {
          toolDefinitionTokens: 100,
          contextFrameTokens: null,
          steeringTokens: 40,
        }),
        hit("2026-09-15T09:04:00.000Z"),
      ],
    });
    await rebuildRunTotals(WORKER, d);
    expect(written[0]?.breakdown.standing).toEqual({
      toolDefinitionTokens: { cached: 200, uncached: 100 },
      contextFrameTokens: null,
      steeringTokens: { cached: 80, uncached: 40 },
    });
  });

  it("writes nothing when the calls cannot be read, so the job retries", async () => {
    const { d, written, sourcesWritten } = deps({
      runs: { [WORKER]: meta(WORKER, "prn_worker_operator") },
    });
    d.readModelCalls = async () => {
      throw new Error("clickhouse down");
    };
    await expect(rebuildRunTotals(WORKER, d)).rejects.toThrow(
      "clickhouse down",
    );
    expect(written).toHaveLength(0);
    expect(sourcesWritten).toHaveLength(0);
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

  it("grades a ledger call's outcome as a failure only when it failed or was denied (ADR-199)", () => {
    expect(ledgerToolStatus("completed")).toBe("ok");
    expect(ledgerToolStatus("failed")).toBe("error");
    expect(ledgerToolStatus("denied")).toBe("rejected");
    // Neither a cancelled call nor one parked on an approval failed.
    expect(ledgerToolStatus("cancelled")).toBeNull();
    expect(ledgerToolStatus("parked")).toBeNull();
    // An encrypted payload carries no outcome to read.
    expect(ledgerToolStatus(null)).toBeNull();
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

// ADR-235, 2026-10-02 amendment. The run rows of the in-app assistant stay
// in every total and out of every read that names a run. Every such read
// takes this one predicate. `findings-store.pg.test.ts` proves the rows.
describe("which run rows are the in-app assistant's", () => {
  it("reads the row's run in the row's workspace on an in-app surface", () => {
    const { sql, params } = new PgDialect().sqlToQuery(inAppRunTotal());
    expect(sql).toMatch(
      /^exists \(select 1 from "agent"\."agent_runs" as "in_app_run" where "in_app_run"\."public_id" = (?:"cost"\.)?"run_totals"\."run_id"::citext/,
    );
    expect(sql).toMatch(
      /"in_app_run"\."org_id" = (?:"cost"\.)?"run_totals"\."org_id"/,
    );
    expect(sql).toMatch(
      /"in_app_run"\."workspace_id" = (?:"cost"\.)?"run_totals"\."workspace_id"/,
    );
    expect(sql).toMatch(/"in_app_run"\."surface" in \(\$\d+, \$\d+\)\)$/);
    // The surfaces come from the one constant the run lists also read.
    expect(params).toEqual([...IN_APP_AGENT_SURFACES]);
  });
});

describe("the price rows a rollup loads (#4202)", () => {
  // The rollup loaded the whole price book, 28,246 rows in production, for
  // every run it priced, and four or five of those steps at once ran the API
  // out of heap. It must ask only for the run's models over the run's span.
  const call = (at: string, model: string): PricedModelCall => ({
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
    tools: [
      { name: "Grep", calls: 2, resultTokens: null, costMicros: null },
      { name: "Read", calls: 1, resultTokens: 1_200, costMicros: 3_600n },
    ],
    steps: { failed: 1, repeated: 2, retried: 0 },
  };

  /** What jsonb hands back: the serialised value through JSON text. */
  const throughJsonb = (value: unknown) => JSON.parse(JSON.stringify(value));

  it("writes each tool's result cost as a decimal string and reads it back (#3892)", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    expect(stored.tools).toEqual([
      { name: "Grep", calls: 2, resultTokens: null, costMicros: null },
      { name: "Read", calls: 1, resultTokens: 1_200, costMicros: "3600" },
    ]);
    expect(stored.steps).toEqual({ failed: 1, repeated: 2, retried: 0 });
    expect(reviveBreakdown(stored).tools).toEqual(breakdown.tools);
  });

  it("reads a row rolled up before tool results and step grades as not recorded, never as 0", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    for (const t of stored.tools) {
      delete t.resultTokens;
      delete t.costMicros;
    }
    delete stored.steps;
    const revived = reviveBreakdown(stored);
    expect(revived.tools).toEqual([
      { name: "Grep", calls: 2, resultTokens: null, costMicros: null },
      { name: "Read", calls: 1, resultTokens: null, costMicros: null },
    ]);
    expect(revived.steps).toBeNull();
  });

  it("writes the step classes beside the causes and reads them back (F17)", () => {
    const classed = { ...breakdown, stepClasses: { readOnly: 5, edit: 2 } };
    const stored = throughJsonb(serializeBreakdown(classed));
    expect(stored.stepClasses).toEqual({ readOnly: 5, edit: 2 });
    expect(stored.steps).toEqual({ failed: 1, repeated: 2, retried: 0 });
    expect(reviveBreakdown(stored)).toEqual(classed);
    const none = throughJsonb(
      serializeBreakdown({ ...breakdown, stepClasses: null }),
    );
    expect(reviveBreakdown(none).stepClasses).toBeNull();
  });

  it("reads a row rolled up before steps had a class with no classes", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    expect("stepClasses" in stored).toBe(false);
    expect(reviveBreakdown(stored).stepClasses).toBeUndefined();
  });

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

  it("writes each model's priced tokens and the re-sent split, and reads them back (#4572)", () => {
    const [first, second] = breakdown.models;
    const kept = {
      ...breakdown,
      models: [
        { ...first!, pricedTokens: { ...first!.tokens } },
        { ...second!, pricedTokens: { ...ZERO_TOKENS } },
      ],
      standing: {
        toolDefinitionTokens: { cached: 200, uncached: 100 },
        contextFrameTokens: null,
        steeringTokens: null,
      },
    };
    const stored = throughJsonb(serializeBreakdown(kept));
    expect(stored.standing).toEqual(kept.standing);
    expect(reviveBreakdown(stored)).toEqual(kept);
  });

  it("reads a row rolled up before #4572 with no priced tokens and no split", () => {
    const stored = throughJsonb(serializeBreakdown(breakdown));
    expect("standing" in stored).toBe(false);
    const revived = reviveBreakdown(stored);
    expect(revived.standing).toBeUndefined();
    expect(revived.models.map((m) => m.pricedTokens)).toEqual([
      undefined,
      undefined,
    ]);
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

describe("streamed rollup reads", () => {
  it("prices batches separately and writes only after every stream completes", async () => {
    const { d, written, sourcesWritten } = deps({ runs: { [WORKER]: meta(WORKER, "owner") } });
    const makeCall = (model: string, at: string): PricedModelCall => ({
      model, at: new Date(at), provider: null, tokens: { ...ZERO_TOKENS, output: 1 },
      reportedCostMicros: 2n, basis: "client_attested",
      sources: { toolDefinitionTokens: 2, contextFrameTokens: null, steeringTokens: 0 },
    });
    d.readModelCalls = vi.fn(() => { throw new Error("unbounded read"); });
    d.readToolCalls = vi.fn(() => { throw new Error("unbounded read"); });
    d.streamModelCalls = async (_args, consume) => {
      await consume([makeCall("first", "2026-09-01T00:00:00Z")]);
      expect(written).toHaveLength(0);
      await consume([makeCall("second", "2026-09-02T00:00:00Z")]);
    };
    d.streamToolCalls = async (_source, consume) => {
      expect(written).toHaveLength(0);
      await consume([]);
    };
    await rebuildRunTotals(WORKER, d);
    expect(d.loadPriceBook).toHaveBeenCalledTimes(2);
    expect(d.loadPriceBook).toHaveBeenNthCalledWith(1, expect.objectContaining({ models: ["first"] }));
    expect(d.loadPriceBook).toHaveBeenNthCalledWith(2, expect.objectContaining({ models: ["second"] }));
    expect(written[0]?.costMicros).toBe(4n);
    expect(sourcesWritten[0]).toEqual({ toolDefinitionTokens: 4, contextFrameTokens: null, steeringTokens: 0 });
  });

  it("does not write totals when pricing exceeds its row budget", async () => {
    const { d, written } = deps({ runs: { [WORKER]: meta(WORKER, "owner") } });
    d.loadPriceBook = async () => { throw new PriceBookSliceLimitError(); };
    await expect(rebuildRunTotals(WORKER, d)).rejects.toBeInstanceOf(PriceBookSliceLimitError);
    expect(written).toHaveLength(0);
  });

  it("leaves the stored totals unchanged when a later batch fails", async () => {
    const { d, written } = deps({ runs: { [WORKER]: meta(WORKER, "owner") } });
    d.streamModelCalls = async (_args, consume) => {
      await consume([]);
      throw new Error("stream interrupted");
    };
    await expect(rebuildRunTotals(WORKER, d)).rejects.toThrow("stream interrupted");
    expect(written).toHaveLength(0);
  });
});
