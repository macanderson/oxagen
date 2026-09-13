// The live runs adapter: port behaviour against injected stores, the tenant
// filters every query carries, and (opt-in) the same reads against a seeded
// local Postgres.
import { closeDatabase, schema, withSystemDb } from "@oxagen/database";
import {
  type AttemptEventReadRecord,
  type AttemptRecord,
  mapAttemptRow,
  type RunSummary,
} from "@oxagen/run-ledger";
import type { TokenUsageByStepRow } from "@oxagen/telemetry";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, inArray, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Frame, RunDetail, RunPage } from "@/data/contracts/runs";
import { ORG_ONLY_WORKSPACE_ID } from "@/data/scope";
import {
  decodeRunCursor,
  encodeRunCursor,
  type LedgerRunCore,
  type LedgerRunIdentity,
  type TachoSessionColumns,
} from "./mappers/runs";
import {
  createLiveRuns,
  defaultLiveRunsDeps,
  ledgerIdentityQuery,
  ledgerPageQuery,
  ledgerRollupQuery,
  ledgerSealQuery,
  type LiveRunsDeps,
  MAX_FRAMES_PER_READ,
  MAX_SKIPPED_EVENT_PAGES,
  RUN_PAGE_SIZE,
  type RunQueries,
  runIdKind,
  tachoPageQuery,
  tachoSessionQuery,
  tachoTouchedQuery,
} from "./runs";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const ORG_ONLY = { orgId: SCOPE.orgId, workspaceId: ORG_ONLY_WORKSPACE_ID };
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SHA = `sha256:${"b".repeat(64)}`;

// ---- Fakes ----------------------------------------------------------------------

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: RUN_UUID,
    publicId: LEDGER_ID,
    surface: "external",
    specVersion: 2,
    status: "completed",
    result: null,
    error: null,
    attemptCount: 1,
    maxAttempts: 3,
    createdAt: new Date("2026-09-11T09:14:00.000Z"),
    startedAt: new Date("2026-09-11T09:14:02.000Z"),
    completedAt: new Date("2026-09-11T09:31:40.000Z"),
    ...over,
  };
}

const identity: LedgerRunIdentity = {
  workspaceSlug: "core-platform",
  orgNamespace: "acme",
  workspaceNamespace: "core",
  agentSlug: "release-manager",
  operatorPublicId: "prn_7h2k9m4q8r1t6v3x5z0b2d",
  goal: "Cut the 4.2 release",
};

function core(over: Partial<LedgerRunCore> = {}): LedgerRunCore {
  const s = summary();
  return {
    runId: s.runId,
    publicId: s.publicId,
    specVersion: s.specVersion,
    status: s.status,
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    ...over,
  };
}

function session(over: Partial<TachoSessionColumns> = {}): TachoSessionColumns {
  return {
    publicId: TACHO_ID,
    agentKey: "acme.core.claude-code-mbell",
    outcome: "running",
    numTurns: 2,
    numModelCalls: 5,
    numToolCalls: 9,
    seqCount: 40,
    totalCostMicros: 812_000,
    hasUnknownModelCost: null,
    inputTokens: 1_000,
    outputTokens: 400,
    cacheReadTokens: 3_000,
    cacheCreationTokens: 0,
    enforcementTier: "observe",
    replayGrade: null,
    modelInitial: "claude-opus-5",
    modelFinal: null,
    startedAt: new Date("2026-09-11T10:00:00.000Z"),
    sealedAt: null,
    ...over,
  };
}

function tachoRow(over: Partial<TachoSessionColumns> = {}) {
  return {
    sessionId: "0192d4a8-7c1e-7a00-8000-0000000005e5",
    session: session(over),
    workspaceSlug: "core-platform",
    operatorPublicId: "prn_7h2k9m4q8r1t6v3x5z0b2d" as string | null,
  };
}

const usageRow: TokenUsageByStepRow = {
  executionStepId: RUN_UUID,
  costMicros: 2_450_000,
  inputTokens: 1,
  outputTokens: 1,
  llmCalls: 1,
  model: "claude-opus-5",
  provider: "anthropic",
  principalId: RUN_UUID,
  principalKind: "agent",
};

function event(
  runSeq: string,
  eventType = "tool.call_completed",
): AttemptEventReadRecord {
  return {
    eventId: `e${runSeq}`,
    attemptId: "a1",
    attemptPublicId: "arat_0123456789abcdef",
    runSeq,
    attemptSeq: Number(runSeq),
    eventSchemaVersion: "agent-run-event/v2",
    eventType,
    stage: "tool",
    payloadDigest: SHA,
    eventDigest: SHA,
    payload: {},
    encryptedPayloadRef: null,
    observedAt: new Date("2026-09-11T09:15:00.000Z"),
    recordedAt: new Date("2026-09-11T09:15:00.000Z"),
  };
}

function sealedAttempt(): AttemptRecord {
  return mapAttemptRow({
    id: "a1",
    public_id: "arat_0123456789abcdef",
    run_id: RUN_UUID,
    attempt_number: 1,
    worker_id: "drain-1",
    engine_name: "stella",
    engine_version: "2.1.1",
    engine_build_digest: SHA,
    resumed_from_attempt_id: null,
    resumed_from_attempt_public_id: null,
    claimed_at: "2026-09-11T09:14:02.000Z",
    seal_id: "s1",
    terminal_status: "completed",
    reason_code: null,
    event_count: 3,
    final_run_seq: "3",
    final_attempt_seq: 3,
    final_event_digest: SHA,
    event_stream_digest: SHA,
    sealed_at: "2026-09-11T09:31:41.000Z",
  });
}

function fakeDeps(
  over: {
    queries?: Partial<RunQueries>;
    store?: Partial<LiveRunsDeps["store"]>;
    sumTokenUsage?: LiveRunsDeps["sumTokenUsage"];
  } = {},
) {
  const inScope = vi.fn();
  const report = vi.fn();
  const queries: RunQueries = {
    ledgerPage: vi.fn(() => Promise.resolve([])),
    ledgerIdentity: vi.fn(() => Promise.resolve(identity)),
    ledgerRollups: vi.fn(() => Promise.resolve(new Map())),
    ledgerSeals: vi.fn(() => Promise.resolve(new Map())),
    tachoPage: vi.fn(() => Promise.resolve([])),
    tachoSession: vi.fn(() => Promise.resolve(null)),
    tachoTouched: vi.fn(() => Promise.resolve([])),
    ...over.queries,
  };
  const store: LiveRunsDeps["store"] = {
    getRunByPublicId: vi.fn(() => Promise.resolve(summary())),
    listRunAttempts: vi.fn(() => Promise.resolve([sealedAttempt()])),
    readAttemptEventsSince: vi.fn(() => Promise.resolve([])),
    ...over.store,
  };
  const sumTokenUsage =
    over.sumTokenUsage ??
    vi.fn(() => Promise.resolve(new Map([[RUN_UUID, usageRow]])));
  const deps: LiveRunsDeps = {
    inScope: (scope, fn) => {
      inScope(scope);
      return fn();
    },
    store,
    queries,
    sumTokenUsage,
    report,
  };
  return { deps, port: createLiveRuns(deps), inScope, report, queries, store };
}

const nb = (milestone: string, gap: string) => ({
  ok: false,
  reason: "not_backed",
  milestone,
  gap,
});
const err = (code: string, status: number) => ({
  ok: false,
  reason: "error",
  code,
  status,
});

// ---- Ids -----------------------------------------------------------------------------

describe("runIdKind", () => {
  it("routes each store's public id and nothing else", () => {
    expect(runIdKind(LEDGER_ID)).toBe("ledger");
    expect(runIdKind(TACHO_ID)).toBe("tacho");
    expect(runIdKind("run_01K5RS")).toBeNull();
    expect(runIdKind("arun_")).toBeNull();
    expect(runIdKind("arun_ABC")).toBeNull();
    expect(runIdKind("tse_x/../y")).toBeNull();
  });
});

// ---- listRuns --------------------------------------------------------------------------

describe("listRuns", () => {
  it("refuses an organization-only scope before any read", async () => {
    const { port, inScope } = fakeDeps();
    await expect(port.listRuns(ORG_ONLY, { filter: "all" })).resolves.toEqual(
      err("workspace_required", 400),
    );
    expect(inScope).not.toHaveBeenCalled();
  });

  it("answers proven as not backed (G7): nothing records a verdict", async () => {
    const { port, queries } = fakeDeps();
    await expect(port.listRuns(SCOPE, { filter: "proven" })).resolves.toEqual(
      nb("M6", "G7"),
    );
    expect(queries.ledgerPage).not.toHaveBeenCalled();
  });

  it("refuses a cursor it did not write", async () => {
    const { port, inScope } = fakeDeps();
    await expect(
      port.listRuns(SCOPE, { filter: "all", cursor: "not-a-cursor" }),
    ).resolves.toEqual(err("invalid_cursor", 400));
    expect(inScope).not.toHaveBeenCalled();
  });

  it("merges ledger runs and wrapped sessions, newest first, in tenant scope", async () => {
    const { port, inScope, queries, deps } = fakeDeps({
      queries: {
        ledgerPage: vi.fn(() => Promise.resolve([{ run: core(), identity }])),
        tachoPage: vi.fn(() => Promise.resolve([tachoRow()])),
      },
    });
    const read = await port.listRuns(SCOPE, { filter: "all" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(RunPage.parse(read.value)).toEqual(read.value);
    expect(read.value.rows.map((r) => r.id)).toEqual([TACHO_ID, LEDGER_ID]);
    expect(read.value.next).toBeNull();
    expect(inScope).toHaveBeenCalledWith(SCOPE);
    const page = { live: false, cursor: null, limit: RUN_PAGE_SIZE };
    expect(queries.ledgerPage).toHaveBeenCalledWith(SCOPE, page);
    expect(queries.tachoPage).toHaveBeenCalledWith(SCOPE, page);
    expect(queries.ledgerRollups).toHaveBeenCalledWith(SCOPE, [RUN_UUID]);
    expect(deps.sumTokenUsage).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      executionStepIds: [RUN_UUID],
    });
  });

  it("passes the live filter and a decoded cursor to both sources", async () => {
    const { port, queries } = fakeDeps();
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: TACHO_ID };
    await port.listRuns(SCOPE, {
      filter: "live",
      cursor: encodeRunCursor(cursor),
    });
    const page = { live: true, cursor, limit: RUN_PAGE_SIZE };
    expect(queries.ledgerPage).toHaveBeenCalledWith(SCOPE, page);
    expect(queries.tachoPage).toHaveBeenCalledWith(SCOPE, page);
  });

  it("skips the ClickHouse read when the page has no ledger run", async () => {
    const sumTokenUsage = vi.fn(() => Promise.resolve(new Map()));
    const { port } = fakeDeps({
      sumTokenUsage,
      queries: { tachoPage: vi.fn(() => Promise.resolve([tachoRow()])) },
    });
    const read = await port.listRuns(SCOPE, { filter: "all" });
    expect(read.ok).toBe(true);
    expect(sumTokenUsage).not.toHaveBeenCalled();
  });

  it("answers an empty page as recorded and none", async () => {
    const { port } = fakeDeps();
    await expect(port.listRuns(SCOPE, { filter: "all" })).resolves.toEqual({
      ok: true,
      value: { rows: [], next: null },
    });
  });

  it("pages at RUN_PAGE_SIZE with a cursor at the last row kept", async () => {
    const rows = Array.from({ length: RUN_PAGE_SIZE + 1 }, (_, i) =>
      tachoRow({
        publicId: `tse_${String(i).padStart(4, "0")}`,
        startedAt: new Date(Date.UTC(2026, 8, 11, 10, 0, 0, 0) - i * 1000),
      }),
    );
    const { port } = fakeDeps({
      queries: { tachoPage: vi.fn(() => Promise.resolve(rows)) },
    });
    const read = await port.listRuns(SCOPE, { filter: "all" });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.rows).toHaveLength(RUN_PAGE_SIZE);
    const last = read.value.rows.at(-1);
    expect(read.value.next && decodeRunCursor(read.value.next)).toEqual({
      at: last?.startedAt,
      id: last?.id,
    });
  });

  it("is not backed when any run on the page cannot be expressed: no run is dropped", async () => {
    const unattributed = { ...tachoRow(), operatorPublicId: null };
    const { port } = fakeDeps({
      queries: {
        ledgerPage: vi.fn(() => Promise.resolve([{ run: core(), identity }])),
        tachoPage: vi.fn(() => Promise.resolve([unattributed])),
      },
    });
    await expect(port.listRuns(SCOPE, { filter: "all" })).resolves.toEqual(
      nb("M1", "G6"),
    );
  });

  it("is not backed (G3) for a ledger run with no metered spend", async () => {
    const { port } = fakeDeps({
      sumTokenUsage: vi.fn(() => Promise.resolve(new Map())),
      queries: {
        ledgerPage: vi.fn(() => Promise.resolve([{ run: core(), identity }])),
      },
    });
    await expect(port.listRuns(SCOPE, { filter: "all" })).resolves.toEqual(
      nb("M2", "G3"),
    );
  });

  it("uses the Fleet seal for a terminal ledger run", async () => {
    const { port } = fakeDeps({
      queries: {
        ledgerPage: vi.fn(() => Promise.resolve([{ run: core(), identity }])),
        ledgerSeals: vi.fn(() =>
          Promise.resolve(
            new Map([[RUN_UUID, new Date("2026-09-11T09:31:41.000Z")]]),
          ),
        ),
      },
    });
    const read = await port.listRuns(SCOPE, { filter: "all" });
    expect(read.ok && read.value.rows[0]?.sealedAt).toBe(
      "2026-09-11T09:31:41.000Z",
    );
  });

  it("reports a store failure and answers Fleet's named error", async () => {
    const failure = new Error("connection refused");
    const { port, report } = fakeDeps({
      queries: { ledgerPage: vi.fn(() => Promise.reject(failure)) },
    });
    await expect(port.listRuns(SCOPE, { filter: "all" })).resolves.toEqual(
      err("run_index_unavailable", 503),
    );
    expect(report).toHaveBeenCalledWith(failure, "live runs.listRuns failed");
  });

  it("answers the error when ClickHouse is down, never a zero cost", async () => {
    const { port } = fakeDeps({
      sumTokenUsage: vi.fn(() => Promise.reject(new Error("breaker open"))),
      queries: {
        ledgerPage: vi.fn(() => Promise.resolve([{ run: core(), identity }])),
      },
    });
    await expect(port.listRuns(SCOPE, { filter: "all" })).resolves.toEqual(
      err("run_index_unavailable", 503),
    );
  });
});

// ---- getRun --------------------------------------------------------------------------

describe("getRun", () => {
  it("refuses an organization-only scope and an unknown id shape", async () => {
    const { port, inScope } = fakeDeps();
    await expect(port.getRun(ORG_ONLY, LEDGER_ID)).resolves.toEqual(
      err("workspace_required", 400),
    );
    await expect(port.getRun(SCOPE, "run_01K5RS")).resolves.toEqual(
      err("run_not_found", 404),
    );
    expect(inScope).not.toHaveBeenCalled();
  });

  it("reads a ledger run through RunStore and answers its gap (G3)", async () => {
    const { port, store, queries, inScope } = fakeDeps();
    await expect(port.getRun(SCOPE, LEDGER_ID)).resolves.toEqual(
      nb("M2", "G3"),
    );
    expect(inScope).toHaveBeenCalledWith(SCOPE);
    expect(store.getRunByPublicId).toHaveBeenCalledWith(LEDGER_ID);
    expect(queries.ledgerIdentity).toHaveBeenCalledWith(SCOPE, RUN_UUID);
    expect(store.listRunAttempts).toHaveBeenCalledWith(RUN_UUID);
  });

  it("404s a ledger id RunStore does not find", async () => {
    const { port } = fakeDeps({
      store: { getRunByPublicId: vi.fn(() => Promise.resolve(null)) },
    });
    await expect(port.getRun(SCOPE, LEDGER_ID)).resolves.toEqual(
      err("run_not_found", 404),
    );
  });

  it("404s a run from another workspace even when RLS let RunStore see it", async () => {
    const { port, store } = fakeDeps({
      queries: { ledgerIdentity: vi.fn(() => Promise.resolve(null)) },
    });
    await expect(port.getRun(SCOPE, LEDGER_ID)).resolves.toEqual(
      err("run_not_found", 404),
    );
    expect(store.listRunAttempts).not.toHaveBeenCalled();
  });

  it("parses a recorded wrapped session through RunDetail", async () => {
    const { port, queries } = fakeDeps({
      queries: {
        tachoSession: vi.fn(() => Promise.resolve(tachoRow())),
        tachoTouched: vi.fn(() => Promise.resolve(["src/release.ts"])),
      },
    });
    const read = await port.getRun(SCOPE, TACHO_ID);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(RunDetail.parse(read.value)).toMatchObject({
      id: TACHO_ID,
      status: "live",
      tier: "observe",
      model: "claude-opus-5",
      cacheHitRate: 0.75,
      touched: ["src/release.ts"],
    });
    expect(queries.tachoSession).toHaveBeenCalledWith(SCOPE, TACHO_ID);
    expect(queries.tachoTouched).toHaveBeenCalledWith(
      SCOPE,
      tachoRow().sessionId,
    );
  });

  it("404s a wrapped session outside the workspace", async () => {
    const { port, queries } = fakeDeps();
    await expect(port.getRun(SCOPE, TACHO_ID)).resolves.toEqual(
      err("run_not_found", 404),
    );
    expect(queries.tachoTouched).not.toHaveBeenCalled();
  });

  it("reports a store failure and answers Run's named error", async () => {
    const { port, report } = fakeDeps({
      store: {
        getRunByPublicId: vi.fn(() => Promise.reject(new Error("down"))),
      },
    });
    await expect(port.getRun(SCOPE, LEDGER_ID)).resolves.toEqual(
      err("frame_store_unreachable", 502),
    );
    expect(report).toHaveBeenCalledOnce();
  });
});

// ---- framesSince ------------------------------------------------------------------------

describe("framesSince", () => {
  it("refuses a bad cursor, an org-only scope and an unknown id without reading", async () => {
    const { port, inScope } = fakeDeps();
    await expect(port.framesSince(SCOPE, LEDGER_ID, "1.5")).resolves.toEqual(
      err("invalid_cursor", 400),
    );
    await expect(port.framesSince(SCOPE, LEDGER_ID, "abc")).resolves.toEqual(
      err("invalid_cursor", 400),
    );
    await expect(port.framesSince(ORG_ONLY, LEDGER_ID, "0")).resolves.toEqual(
      err("workspace_required", 400),
    );
    await expect(port.framesSince(SCOPE, "nope", "0")).resolves.toEqual(
      err("run_not_found", 404),
    );
    expect(inScope).not.toHaveBeenCalled();
  });

  it("answers a wrapped session's frames as not backed (G6)", async () => {
    const { port, inScope } = fakeDeps();
    await expect(port.framesSince(SCOPE, TACHO_ID, "0")).resolves.toEqual(
      nb("M1", "G6"),
    );
    expect(inScope).not.toHaveBeenCalled();
  });

  it("maps ledger events after the cursor and skips kinds with no frame", async () => {
    const readAttemptEventsSince = vi.fn(() =>
      Promise.resolve([
        event("5", "admission.run_admitted"),
        event("6", "checkout.completed"),
        event("7", "tool.call_completed"),
      ]),
    );
    const { port } = fakeDeps({ store: { readAttemptEventsSince } });
    const read = await port.framesSince(SCOPE, LEDGER_ID, "4", 50);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.map((f) => [f.seq, f.kind])).toEqual([
      ["5", "agent.start"],
      ["7", "tool.result"],
    ]);
    for (const frame of read.value) expect(Frame.parse(frame)).toEqual(frame);
    expect(readAttemptEventsSince).toHaveBeenCalledWith(RUN_UUID, "4", 50);
  });

  it("reads from the start for a negative cursor", async () => {
    const readAttemptEventsSince = vi.fn(() => Promise.resolve([]));
    const { port } = fakeDeps({ store: { readAttemptEventsSince } });
    await expect(port.framesSince(SCOPE, LEDGER_ID, "-1")).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(readAttemptEventsSince).toHaveBeenCalledWith(RUN_UUID, "0", 200);
  });

  it("clamps the page size", async () => {
    const readAttemptEventsSince = vi.fn(() => Promise.resolve([]));
    const { port } = fakeDeps({ store: { readAttemptEventsSince } });
    await port.framesSince(SCOPE, LEDGER_ID, "0", 100_000);
    await port.framesSince(SCOPE, LEDGER_ID, "0", 0);
    expect(readAttemptEventsSince).toHaveBeenNthCalledWith(
      1,
      RUN_UUID,
      "0",
      MAX_FRAMES_PER_READ,
    );
    expect(readAttemptEventsSince).toHaveBeenNthCalledWith(2, RUN_UUID, "0", 1);
  });

  it("reads past a full page of unmapped events so the cursor never parks", async () => {
    const readAttemptEventsSince = vi
      .fn<LiveRunsDeps["store"]["readAttemptEventsSince"]>()
      .mockResolvedValueOnce([
        event("1", "checkout.completed"),
        event("2", "change.recorded"),
      ])
      .mockResolvedValueOnce([event("3", "tool.call_completed")]);
    const { port } = fakeDeps({ store: { readAttemptEventsSince } });
    const read = await port.framesSince(SCOPE, LEDGER_ID, "0", 2);
    expect(read.ok && read.value.map((f) => f.seq)).toEqual(["3"]);
    expect(readAttemptEventsSince).toHaveBeenNthCalledWith(2, RUN_UUID, "2", 2);
  });

  it("stops after MAX_SKIPPED_EVENT_PAGES pages of unmapped events", async () => {
    let seq = 0;
    const readAttemptEventsSince = vi.fn(() => {
      seq += 1;
      return Promise.resolve([event(String(seq), "change.recorded")]);
    });
    const { port } = fakeDeps({ store: { readAttemptEventsSince } });
    await expect(port.framesSince(SCOPE, LEDGER_ID, "0", 1)).resolves.toEqual({
      ok: true,
      value: [],
    });
    expect(readAttemptEventsSince).toHaveBeenCalledTimes(
      MAX_SKIPPED_EVENT_PAGES,
    );
  });

  it("404s a run outside the workspace before reading its events", async () => {
    const { port, store } = fakeDeps({
      queries: { ledgerIdentity: vi.fn(() => Promise.resolve(null)) },
    });
    await expect(port.framesSince(SCOPE, LEDGER_ID, "0")).resolves.toEqual(
      err("run_not_found", 404),
    );
    expect(store.readAttemptEventsSince).not.toHaveBeenCalled();
  });

  it("reports a store failure and answers Run's named error", async () => {
    const { port, report } = fakeDeps({
      store: {
        readAttemptEventsSince: vi.fn(() => Promise.reject(new Error("down"))),
      },
    });
    await expect(port.framesSince(SCOPE, LEDGER_ID, "0")).resolves.toEqual(
      err("frame_store_unreachable", 502),
    );
    expect(report).toHaveBeenCalledOnce();
  });
});

describe("reads nothing records yet", () => {
  it.each([
    ["transcript", nb("M1", "G6")],
    ["runGraph", nb("M1", "G6")],
    ["contextWindow", nb("M3", "G10")],
    ["proof", nb("M6", "G7")],
  ] as const)("%s answers its milestone and gap", async (method, expected) => {
    const { port, inScope } = fakeDeps();
    await expect(port[method](SCOPE, LEDGER_ID)).resolves.toEqual(expected);
    expect(inScope).not.toHaveBeenCalled();
  });
});

// ---- Query tenant filters ----------------------------------------------------------------

describe("queries name the tenant", () => {
  const db = drizzle.mock({ schema });
  const page = { live: false, cursor: null, limit: RUN_PAGE_SIZE };
  const cases = [
    ["ledgerPageQuery", ledgerPageQuery(db, SCOPE, page).toSQL()],
    ["ledgerIdentityQuery", ledgerIdentityQuery(db, SCOPE, RUN_UUID).toSQL()],
    ["ledgerRollupQuery", ledgerRollupQuery(db, SCOPE, [RUN_UUID]).toSQL()],
    ["ledgerSealQuery", ledgerSealQuery(db, SCOPE, [RUN_UUID]).toSQL()],
    ["tachoPageQuery", tachoPageQuery(db, SCOPE, page).toSQL()],
    ["tachoSessionQuery", tachoSessionQuery(db, SCOPE, TACHO_ID).toSQL()],
    ["tachoTouchedQuery", tachoTouchedQuery(db, SCOPE, RUN_UUID).toSQL()],
  ] as const;

  it.each(cases)("%s filters on org_id and workspace_id", (_name, query) => {
    expect(query.sql).toMatch(/"org_id" = \$\d+/);
    expect(query.sql).toMatch(/"workspace_id" = \$\d+/);
    expect(query.params).toContain(SCOPE.orgId);
    expect(query.params).toContain(SCOPE.workspaceId);
  });

  it("a different scope binds different tenant ids (negative)", () => {
    const other = {
      orgId: "0192d4a8-7c1e-7a00-8000-000000000bad",
      workspaceId: "0192d4a8-7c1e-7a00-8000-000000000bad",
    };
    const query = ledgerPageQuery(db, other, page).toSQL();
    expect(query.params).not.toContain(SCOPE.orgId);
    expect(query.params).not.toContain(SCOPE.workspaceId);
  });

  it("lists V2 ledger runs and root sessions only", () => {
    const ledger = ledgerPageQuery(db, SCOPE, page).toSQL();
    expect(ledger.sql).toMatch(/"spec_version" = \$\d+/);
    expect(ledger.params).toContain(2);
    expect(tachoPageQuery(db, SCOPE, page).toSQL().sql).toMatch(
      /"parent_session_uuid" is null/,
    );
  });

  it("applies the live filter and the cursor", () => {
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: LEDGER_ID };
    const live = { live: true, cursor, limit: 10 };
    const ledger = ledgerPageQuery(db, SCOPE, live).toSQL();
    expect(ledger.params).toEqual(
      expect.arrayContaining(["pending", "running", LEDGER_ID, 11]),
    );
    expect(ledger.sql).toContain("date_trunc('milliseconds'");
    const tacho = tachoPageQuery(db, SCOPE, live).toSQL();
    expect(tacho.params).toEqual(
      expect.arrayContaining(["running", LEDGER_ID, 11]),
    );
  });
});

// ---- Against a seeded local Postgres (opt-in) ------------------------------------------
//
// MC_LIVE_DB_TEST=1 with DATABASE_URL and the CLICKHOUSE_* variables pointing at
// the local stack (CLAUDE.md: Postgres :5433, ClickHouse :8123). Seeds one V2
// ledger run with an attempt, three events and a seal, and one root tacho
// session with a touched file, reads them back through the real adapter, and
// deletes every seeded row.

describe.runIf(process.env.MC_LIVE_DB_TEST === "1")(
  "live runs against a seeded local Postgres",
  () => {
    const sha = (c: string) => `sha256:${c.repeat(64)}`;
    const suffix = crypto.randomUUID().slice(0, 8);
    const seeded = {
      scope: { orgId: "", workspaceId: "" },
      principalId: "",
      operatorPublicId: "",
      agentId: "",
      runId: "",
      runPublicId: "",
      attemptId: "",
      sessionId: "",
      sessionPublicId: "",
      agentKey: "",
    };
    const port = createLiveRuns(defaultLiveRunsDeps());

    beforeAll(async () => {
      await withSystemDb(async (tx) => {
        const [ws] = await tx
          .select({
            orgId: schema.workspaces.orgId,
            workspaceId: schema.workspaces.id,
            orgNamespace: schema.organizations.namespace,
            workspaceNamespace: schema.workspaces.namespace,
          })
          .from(schema.workspaces)
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.workspaces.orgId),
          )
          .where(isNotNull(schema.workspaces.namespace))
          .limit(1);
        if (!ws) throw new Error("no workspace to seed into");
        seeded.scope = { orgId: ws.orgId, workspaceId: ws.workspaceId };
        const tenant = { orgId: ws.orgId, workspaceId: ws.workspaceId };

        const [principal] = await tx
          .insert(schema.principals)
          .values({ ...tenant, kind: "human", displayName: "A1 verify" })
          .returning({
            id: schema.principals.id,
            publicId: schema.principals.publicId,
          });
        if (!principal) throw new Error("principal not seeded");
        seeded.principalId = principal.id;
        seeded.operatorPublicId = principal.publicId;

        const [agent] = await tx
          .insert(schema.agents)
          .values({
            ...tenant,
            slug: `a1-verify-${suffix}`,
            name: "A1 verify",
            agentType: "custom",
          })
          .returning({ id: schema.agents.id });
        if (!agent) throw new Error("agent not seeded");
        seeded.agentId = agent.id;
        seeded.agentKey = `${ws.orgNamespace}.${ws.workspaceNamespace}.a1-verify-${suffix}`;

        const started = new Date("2026-09-11T09:14:02.000Z");
        const [run] = await tx
          .insert(schema.agentRuns)
          .values({
            ...tenant,
            surface: "external",
            status: "completed",
            spec: { goal: "Verify the live runs adapter" },
            specVersion: 2,
            runKind: "general",
            specDigest: sha("1"),
            initiatingPrincipalId: principal.id,
            agentPrincipalId: crypto.randomUUID(),
            agentId: agent.id,
            agentVersionId: crypto.randomUUID(),
            agentVersionChecksum: "a1-verify",
            authorizationSnapshotId: crypto.randomUUID(),
            repositoryBindingId: crypto.randomUUID(),
            repositoryProvider: "github",
            providerRepositoryId: "1",
            repositoryConnectionId: crypto.randomUUID(),
            configuredDefaultRef: "main",
            baseCommitSha: "a".repeat(40),
            baseTreeSha: "b".repeat(40),
            retentionPolicyId: crypto.randomUUID(),
            retentionPolicyDigest: sha("2"),
            maxAttempts: 3,
            attemptCount: 1,
            nextRunSeq: 4,
            startedAt: started,
            completedAt: new Date("2026-09-11T09:31:40.000Z"),
          })
          .returning({
            id: schema.agentRuns.id,
            publicId: schema.agentRuns.publicId,
          });
        if (!run) throw new Error("run not seeded");
        seeded.runId = run.id;
        seeded.runPublicId = run.publicId;

        const [attempt] = await tx
          .insert(schema.agentRunAttempts)
          .values({
            ...tenant,
            runId: run.id,
            attemptNumber: 1,
            workerId: "a1-verify",
            engineName: "stella",
            engineVersion: "2.1.1",
            engineBuildDigest: sha("3"),
          })
          .returning({ id: schema.agentRunAttempts.id });
        if (!attempt) throw new Error("attempt not seeded");
        seeded.attemptId = attempt.id;

        const base = {
          ...tenant,
          runId: run.id,
          eventRecordVersion: 2,
          attemptId: attempt.id,
          eventSchemaVersion: "agent-run-event/v2",
          payloadDigest: sha("4"),
          encryptedPayloadRef: null,
        };
        await tx.insert(schema.agentRunEvents).values([
          {
            ...base,
            runSeq: 1,
            attemptSeq: 1,
            eventType: "admission.run_admitted",
            stage: "admission",
            eventDigest: sha("5"),
            payloadInline: { engine_name: "stella", engine_version: "2.1.1" },
            observedAt: new Date("2026-09-11T09:14:03.000Z"),
          },
          {
            ...base,
            runSeq: 2,
            attemptSeq: 2,
            eventType: "checkout.completed",
            stage: "checkout",
            eventDigest: sha("6"),
            payloadInline: { provider_repository_id: "1" },
            observedAt: new Date("2026-09-11T09:14:04.000Z"),
          },
          {
            ...base,
            runSeq: 3,
            attemptSeq: 3,
            eventType: "model.call_completed",
            stage: "model",
            eventDigest: sha("7"),
            payloadInline: {
              turn_index: 0,
              provider: "anthropic",
              model: "claude-opus-5",
            },
            observedAt: new Date("2026-09-11T09:15:00.000Z"),
          },
        ]);
        await tx.insert(schema.agentRunAttemptSeals).values({
          ...tenant,
          runId: run.id,
          attemptId: attempt.id,
          terminalStatus: "completed",
          eventCount: 3,
          finalRunSeq: 3,
          finalAttemptSeq: 3,
          finalEventDigest: sha("7"),
          eventStreamDigest: sha("8"),
          sealerKind: "ingress",
          sealerWorkerId: "a1-verify",
        });

        const sessionUuid = crypto.randomUUID();
        const [tachoSession] = await tx
          .insert(schema.tachoSessions)
          .values({
            ...tenant,
            sessionUuid,
            harnessSessionId: `a1-verify-${suffix}`,
            agentKey: `${ws.orgNamespace}.${ws.workspaceNamespace}.claude-code-a1`,
            initiatingPrincipalId: principal.id,
            rootSessionUuid: sessionUuid,
            runtime: "claude-code",
            harness: "claude-code",
            outcome: "running",
            enforcementTier: "harness",
            startedAt: new Date(Date.now() + 60_000),
            lastEventAt: new Date(Date.now() + 60_000),
            numTurns: 2,
            numModelCalls: 4,
            numToolCalls: 6,
            seqCount: 30,
            inputTokens: 1_000,
            outputTokens: 300,
            cacheReadTokens: 3_000,
            totalCostMicros: 640_000,
            modelInitial: "claude-opus-5",
          })
          .returning({
            id: schema.tachoSessions.id,
            publicId: schema.tachoSessions.publicId,
          });
        if (!tachoSession) throw new Error("session not seeded");
        seeded.sessionId = tachoSession.id;
        seeded.sessionPublicId = tachoSession.publicId;
        await tx.insert(schema.tachoSessionFiles).values({
          ...tenant,
          sessionId: tachoSession.id,
          path: "src/release.ts",
          writes: 1,
          firstSeq: 3,
          lastSeq: 9,
        });
      });
    }, 30_000);

    afterAll(async () => {
      await withSystemDb(async (tx) => {
        if (seeded.sessionId) {
          await tx
            .delete(schema.tachoSessionFiles)
            .where(eq(schema.tachoSessionFiles.sessionId, seeded.sessionId));
          await tx
            .delete(schema.tachoSessions)
            .where(eq(schema.tachoSessions.id, seeded.sessionId));
        }
        if (seeded.runId) {
          await tx
            .delete(schema.agentRunAttemptSeals)
            .where(eq(schema.agentRunAttemptSeals.runId, seeded.runId));
          await tx
            .delete(schema.agentRunEvents)
            .where(eq(schema.agentRunEvents.runId, seeded.runId));
          await tx
            .delete(schema.agentRunAttempts)
            .where(eq(schema.agentRunAttempts.runId, seeded.runId));
          await tx
            .delete(schema.agentRuns)
            .where(inArray(schema.agentRuns.id, [seeded.runId]));
        }
        if (seeded.agentId)
          await tx
            .delete(schema.agents)
            .where(eq(schema.agents.id, seeded.agentId));
        if (seeded.principalId)
          await tx
            .delete(schema.principals)
            .where(eq(schema.principals.id, seeded.principalId));
      });
      await closeDatabase();
    }, 30_000);

    it("reads the seeded wrapped session as a RunDetail", async () => {
      const read = await port.getRun(seeded.scope, seeded.sessionPublicId);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(RunDetail.parse(read.value)).toMatchObject({
        id: seeded.sessionPublicId,
        operatorId: seeded.operatorPublicId,
        status: "live",
        turns: 2,
        steps: 10,
        frames: 30,
        cost: { micros: "640000", currency: "USD", basis: "client_attested" },
        tier: "harness",
        model: "claude-opus-5",
        cacheHitRate: 0.75,
        touched: ["src/release.ts"],
      });
    });

    it("lists the live wrapped session on Fleet's live filter", async () => {
      const read = await port.listRuns(seeded.scope, { filter: "live" });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(RunPage.parse(read.value).rows[0]?.id).toBe(
        seeded.sessionPublicId,
      );
    });

    it("reads the ledger run through RunStore and names the cost gap", async () => {
      await expect(
        port.getRun(seeded.scope, seeded.runPublicId),
      ).resolves.toEqual(nb("M2", "G3"));
      // The completed ledger run has no metered spend in token_usage: the page
      // that holds it is not expressible, and ClickHouse answered (not 503).
      await expect(
        port.listRuns(seeded.scope, { filter: "all" }),
      ).resolves.toEqual(nb("M2", "G3"));
    });

    it("streams the ledger run's frames, skipping the checkout event", async () => {
      const read = await port.framesSince(
        seeded.scope,
        seeded.runPublicId,
        "-1",
      );
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.map((f) => [f.seq, f.kind, f.summary])).toEqual([
        ["1", "agent.start", "stella@2.1.1"],
        ["3", "model.response", "anthropic/claude-opus-5"],
      ]);
      const after = await port.framesSince(
        seeded.scope,
        seeded.runPublicId,
        "1",
      );
      expect(after.ok && after.value.map((f) => f.seq)).toEqual(["3"]);
    });

    it("404s both runs from another workspace in the same organization", async () => {
      const other = {
        orgId: seeded.scope.orgId,
        workspaceId: "0192d4a8-7c1e-7a00-8000-00000000dead",
      };
      await expect(port.getRun(other, seeded.runPublicId)).resolves.toEqual(
        err("run_not_found", 404),
      );
      await expect(port.getRun(other, seeded.sessionPublicId)).resolves.toEqual(
        err("run_not_found", 404),
      );
      await expect(
        port.framesSince(other, seeded.runPublicId, "0"),
      ).resolves.toEqual(err("run_not_found", 404));
    });
  },
);
