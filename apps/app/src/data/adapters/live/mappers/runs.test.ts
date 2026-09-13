// Contract tests for the live runs mappers. Ledger records are produced by
// @oxagen/run-ledger's own row mappers from driver-shaped rows, and tacho rows
// are typed from drizzle's `$inferSelect`, so each test parses what the store
// really returns through the view-model schema.
import {
  type AttemptEventReadRow,
  type AttemptRow,
  mapAttemptEventReadRow,
  mapAttemptRow,
  mapRunSummaryRow,
  type RunSummaryRow,
} from "@oxagen/run-ledger";
import type { TokenUsageByStepRow } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { Frame, RunDetail, RunRow } from "@/data/contracts/runs";
import {
  composeAgentKey,
  compareRunsNewestFirst,
  decodeRunCursor,
  EMPTY_ROLLUP,
  encodeRunCursor,
  LEDGER_FRAME_KINDS,
  type LedgerRunRecord,
  latestSealAt,
  ledgerCost,
  ledgerFrameSummary,
  ledgerRunStatus,
  mergeNewestFirst,
  microsString,
  notBackedFor,
  RUN_RECORD_INVALID,
  type TachoSessionColumns,
  type TachoSessionRecord,
  tachoCacheHitRate,
  tachoCost,
  tachoRunStatus,
  toLedgerFrame,
  toLedgerRunDetail,
  toLedgerRunRow,
  toTachoRunDetail,
  toTachoRunRow,
  UNMAPPED_LEDGER_EVENT_TYPES,
} from "./runs";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";

// ---- Ledger fixtures ------------------------------------------------------------

function summaryRow(over: Partial<RunSummaryRow> = {}): RunSummaryRow {
  return {
    id: RUN_UUID,
    public_id: "arun_5f0c2e9a1b7d4c3e8f6a02",
    surface: "external",
    spec_version: 2,
    status: "completed",
    result: null,
    error: null,
    attempt_count: 1,
    max_attempts: 3,
    created_at: "2026-09-11T09:14:00.000Z",
    started_at: "2026-09-11T09:14:02.000Z",
    completed_at: "2026-09-11T09:31:40.000Z",
    ...over,
  };
}

function usage(over: Partial<TokenUsageByStepRow> = {}): TokenUsageByStepRow {
  return {
    executionStepId: RUN_UUID,
    costMicros: 2_450_000,
    inputTokens: 120_000,
    outputTokens: 8_400,
    llmCalls: 14,
    model: "claude-opus-5",
    provider: "anthropic",
    principalId: "0192d4a8-7c1e-7a00-8000-0000000000b2",
    principalKind: "agent",
    ...over,
  };
}

function ledgerRecord(over: Partial<LedgerRunRecord> = {}): LedgerRunRecord {
  return {
    run: mapRunSummaryRow(summaryRow()),
    identity: {
      workspaceSlug: "core-platform",
      orgNamespace: "acme",
      workspaceNamespace: "core",
      agentSlug: "release-manager",
      operatorPublicId: "prn_7h2k9m4q8r1t6v3x5z0b2d",
      goal: "Cut the 4.2 release",
    },
    rollup: {
      frames: 42,
      modelCalls: 14,
      toolCalls: 9,
      turnIndexes: 3,
      opaqueModelCalls: 0,
      lastModel: "claude-opus-5",
    },
    sealedAt: new Date("2026-09-11T09:31:41.000Z"),
    usage: usage(),
    ...over,
  };
}

function attemptRow(over: Partial<AttemptRow> = {}): AttemptRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
    public_id: "arat_0123456789abcdef",
    run_id: RUN_UUID,
    attempt_number: 1,
    worker_id: "drain-1",
    engine_name: "stella",
    engine_version: "2.1.1",
    engine_build_digest: SHA_A,
    resumed_from_attempt_id: null,
    resumed_from_attempt_public_id: null,
    claimed_at: "2026-09-11T09:14:02.000Z",
    seal_id: "seal-1",
    terminal_status: "completed",
    reason_code: null,
    event_count: 42,
    final_run_seq: "42",
    final_attempt_seq: 42,
    final_event_digest: SHA_A,
    event_stream_digest: SHA_B,
    sealed_at: "2026-09-11T09:31:41.000Z",
    ...over,
  };
}

function eventRow(
  over: Partial<AttemptEventReadRow> = {},
): AttemptEventReadRow {
  return {
    id: "0192d4a8-7c1e-7a00-8000-0000000000e1",
    attempt_id: "0192d4a8-7c1e-7a00-8000-0000000000c1",
    attempt_public_id: "arat_0123456789abcdef",
    run_seq: "7",
    attempt_seq: 7,
    event_schema_version: "agent-run-event/v2",
    event_type: "model.call_completed",
    stage: "model",
    payload_digest: SHA_A,
    event_digest: SHA_B,
    payload_inline: {
      model_call_id: "mc_1",
      turn_index: 1,
      provider: "anthropic",
      model: "claude-opus-5",
      outcome: "completed",
    },
    encrypted_payload_ref: null,
    observed_at: "2026-09-11T09:15:10.250Z",
    created_at: "2026-09-11T09:15:10.300Z",
    ...over,
  };
}

// ---- Tacho fixtures ---------------------------------------------------------------

function tachoSession(
  over: Partial<TachoSessionColumns> = {},
): TachoSessionColumns {
  return {
    publicId: "tse_4q8r1t6v3x5z0b2d7h2k9m",
    agentKey: "acme.core.claude-code-mbell",
    outcome: "completed",
    numTurns: 6,
    numModelCalls: 31,
    numToolCalls: 57,
    seqCount: 214,
    totalCostMicros: 3_120_450,
    hasUnknownModelCost: false,
    inputTokens: 40_000,
    outputTokens: 12_000,
    cacheReadTokens: 150_000,
    cacheCreationTokens: 10_000,
    enforcementTier: "harness",
    replayGrade: "inspect",
    modelInitial: "claude-sonnet-5",
    modelFinal: "claude-opus-5",
    startedAt: new Date("2026-09-11T10:00:00.000Z"),
    sealedAt: new Date("2026-09-11T10:42:13.000Z"),
    ...over,
  };
}

function tachoRecord(
  over: Partial<TachoSessionRecord> = {},
  session: Partial<TachoSessionColumns> = {},
): TachoSessionRecord {
  return {
    session: tachoSession(session),
    workspaceSlug: "core-platform",
    operatorPublicId: "prn_7h2k9m4q8r1t6v3x5z0b2d",
    ...over,
  };
}

const nb = (milestone: string, gap: string) => ({
  ok: false,
  reason: "not_backed",
  milestone,
  gap,
});

// ---- Scalars ------------------------------------------------------------------------

describe("scalars", () => {
  it("writes micros as an integer decimal string", () => {
    expect(microsString(2_450_000)).toBe("2450000");
    expect(microsString(0)).toBe("0");
    expect(microsString(12345678901234567890n)).toBe("12345678901234567890");
  });

  it("refuses a float or a non-number rather than rounding it", () => {
    expect(() => microsString(1.5)).toThrow(RangeError);
    expect(() => microsString(Number.NaN)).toThrow(RangeError);
    expect(() => microsString(2 ** 60)).toThrow(RangeError);
  });

  it("composes an agent key only from both namespaces and a slug", () => {
    expect(composeAgentKey("acme", "core", "release-manager")).toBe(
      "acme.core.release-manager",
    );
    expect(composeAgentKey(null, "core", "x")).toBeNull();
    expect(composeAgentKey("acme", null, "x")).toBeNull();
    expect(composeAgentKey("acme", "core", null)).toBeNull();
    expect(composeAgentKey("", "core", "x")).toBeNull();
  });

  it("names the earliest milestone among unrecorded fields", () => {
    expect(notBackedFor(["cost", "operatorId"])).toEqual(nb("M1", "G6"));
    expect(notBackedFor(["cacheHitRate", "cost"])).toEqual(nb("M2", "G3"));
    expect(() => notBackedFor([])).toThrow();
  });
});

// ---- Ledger runs ---------------------------------------------------------------------

describe("ledger run status", () => {
  it.each([
    ["pending", "live"],
    ["running", "live"],
    ["completed", "sealed"],
    ["failed", "sealed"],
    ["cancelled", "halted"],
  ])("%s → %s", (status, expected) => {
    expect(ledgerRunStatus(status)).toBe(expected);
  });

  it("answers null for a word outside the column's CHECK", () => {
    expect(ledgerRunStatus("paused")).toBeNull();
    expect(ledgerRunStatus("constructor")).toBeNull();
    expect(ledgerRunStatus("")).toBeNull();
  });
});

describe("latestSealAt", () => {
  it("is the latest seal when every attempt is sealed", () => {
    const attempts = [
      mapAttemptRow(attemptRow({ sealed_at: "2026-09-11T09:20:00.000Z" })),
      mapAttemptRow(
        attemptRow({
          attempt_number: 2,
          sealed_at: "2026-09-11T09:31:41.000Z",
        }),
      ),
    ];
    expect(latestSealAt(attempts)?.toISOString()).toBe(
      "2026-09-11T09:31:41.000Z",
    );
  });

  it("is null while an attempt is open, and for no attempts", () => {
    const open = mapAttemptRow(
      attemptRow({ seal_id: null, event_stream_digest: null, sealed_at: null }),
    );
    expect(latestSealAt([mapAttemptRow(attemptRow()), open])).toBeNull();
    expect(latestSealAt([])).toBeNull();
  });
});

describe("ledgerCost", () => {
  it("is gateway-observed USD micros from token_usage", () => {
    expect(ledgerCost(usage())).toEqual({
      micros: "2450000",
      currency: "USD",
      basis: "gateway_observed",
    });
  });

  it("is null, never zero, when no token_usage row exists", () => {
    expect(ledgerCost(null)).toBeNull();
  });
});

describe("toLedgerRunRow", () => {
  it("parses a fully recorded V2 run through RunRow", () => {
    const read = toLedgerRunRow(ledgerRecord());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(RunRow.parse(read.value)).toEqual(read.value);
    expect(read.value).toEqual({
      id: "arun_5f0c2e9a1b7d4c3e8f6a02",
      name: null,
      agentKey: "acme.core.release-manager",
      operatorId: "prn_7h2k9m4q8r1t6v3x5z0b2d",
      workspaceSlug: "core-platform",
      status: "sealed",
      turns: 3,
      steps: 23,
      frames: 42,
      cost: { micros: "2450000", currency: "USD", basis: "gateway_observed" },
      tier: null,
      grade: null,
      verdict: null,
      taskRef: "Cut the 4.2 release",
      startedAt: "2026-09-11T09:14:02.000Z",
      sealedAt: "2026-09-11T09:31:41.000Z",
    });
  });

  it("starts at admission when the run never recorded a start", () => {
    const read = toLedgerRunRow(
      ledgerRecord({
        run: mapRunSummaryRow(summaryRow({ started_at: null })),
      }),
    );
    expect(read.ok && read.value.startedAt).toBe("2026-09-11T09:14:00.000Z");
  });

  it("shows no seal on a live run, even beside an earlier attempt's seal", () => {
    const read = toLedgerRunRow(
      ledgerRecord({
        run: mapRunSummaryRow(summaryRow({ status: "running" })),
      }),
    );
    expect(read.ok && read.value).toMatchObject({
      status: "live",
      sealedAt: null,
    });
  });

  it("counts an empty event log as zero frames, steps and turns", () => {
    const read = toLedgerRunRow(ledgerRecord({ rollup: EMPTY_ROLLUP }));
    expect(read.ok && read.value).toMatchObject({
      frames: 0,
      steps: 0,
      turns: 0,
    });
  });

  it("is not backed (G3) when no spend was metered, never a zero cost", () => {
    expect(toLedgerRunRow(ledgerRecord({ usage: null }))).toEqual(
      nb("M2", "G3"),
    );
  });

  it("is not backed (G6) without an operator, before any cost gap", () => {
    const record = ledgerRecord({ usage: null });
    record.identity = { ...record.identity, operatorPublicId: null };
    expect(toLedgerRunRow(record)).toEqual(nb("M1", "G6"));
  });

  it("is not backed (G6) when an agent namespace is missing", () => {
    const record = ledgerRecord();
    record.identity = { ...record.identity, workspaceNamespace: null };
    expect(toLedgerRunRow(record)).toEqual(nb("M1", "G6"));
  });

  it("is not backed (G6) when a model call's turn is in an encrypted payload", () => {
    const record = ledgerRecord();
    record.rollup = { ...record.rollup, opaqueModelCalls: 1 };
    expect(toLedgerRunRow(record)).toEqual(nb("M1", "G6"));
  });

  it("is not backed for a legacy spec_version 1 row", () => {
    const read = toLedgerRunRow(
      ledgerRecord({ run: mapRunSummaryRow(summaryRow({ spec_version: 1 })) }),
    );
    expect(read).toEqual(nb("M1", "G6"));
  });

  it("answers run_record_invalid for a status outside the CHECK", () => {
    const record = ledgerRecord();
    record.run = { ...record.run, status: "paused" };
    expect(toLedgerRunRow(record)).toEqual({
      ok: false,
      reason: "error",
      code: RUN_RECORD_INVALID,
      status: 500,
    });
  });

  it("answers run_record_invalid when a recorded value breaks RunRow", () => {
    const record = ledgerRecord();
    record.run = { ...record.run, publicId: "arun-not-a-public-id" };
    expect(toLedgerRunRow(record)).toMatchObject({ code: RUN_RECORD_INVALID });
  });
});

describe("toLedgerRunDetail", () => {
  it("is not backed (G3): token_usage step sums carry no cache hit rate", () => {
    expect(toLedgerRunDetail(ledgerRecord())).toEqual(nb("M2", "G3"));
  });

  it("names the model gap (G6) when no model call recorded a model", () => {
    expect(
      toLedgerRunDetail(
        ledgerRecord({
          usage: usage({ model: "" }),
          rollup: { ...EMPTY_ROLLUP },
        }),
      ),
    ).toEqual(nb("M1", "G6"));
  });

  it("is not backed for a legacy row and invalid for a bad status", () => {
    expect(
      toLedgerRunDetail(
        ledgerRecord({
          run: mapRunSummaryRow(summaryRow({ spec_version: 1 })),
        }),
      ),
    ).toEqual(nb("M1", "G6"));
    const record = ledgerRecord();
    record.run = { ...record.run, status: "paused" };
    expect(toLedgerRunDetail(record)).toMatchObject({
      code: RUN_RECORD_INVALID,
    });
  });
});

// ---- Ledger frames ------------------------------------------------------------------

describe("toLedgerFrame", () => {
  it("maps a model call to a model.response frame that parses as a Frame", () => {
    const frame = toLedgerFrame(mapAttemptEventReadRow(eventRow()));
    expect(frame).not.toBeNull();
    expect(Frame.parse(frame)).toEqual({
      seq: "7",
      kind: "model.response",
      ts: "2026-09-11T09:15:10.250Z",
      tier: null,
      cost: null,
      summary: "anthropic/claude-opus-5",
      hash: SHA_B,
      prevHash: null,
    });
  });

  it.each(Object.entries(LEDGER_FRAME_KINDS))("%s → %s", (eventType, kind) => {
    const frame = toLedgerFrame(
      mapAttemptEventReadRow(
        eventRow({ event_type: eventType, payload_inline: {} }),
      ),
    );
    expect(frame?.kind).toBe(kind);
    expect(Frame.safeParse(frame).success).toBe(true);
  });

  it.each(UNMAPPED_LEDGER_EVENT_TYPES)(
    "%s has no frame kind and is skipped, not relabelled",
    (eventType) => {
      expect(
        toLedgerFrame(
          mapAttemptEventReadRow(eventRow({ event_type: eventType })),
        ),
      ).toBeNull();
    },
  );

  it("keeps run_seq as an exact decimal past 2^53", () => {
    const frame = toLedgerFrame(
      mapAttemptEventReadRow(eventRow({ run_seq: "9007199254740993" })),
    );
    expect(frame?.seq).toBe("9007199254740993");
  });

  it.each([
    [
      "admission.run_admitted",
      { engine_name: "stella", engine_version: "2.1.1" },
      "stella@2.1.1",
    ],
    ["context.frames_selected", { frame_count: 12 }, "frames=12"],
    [
      "tool.call_completed",
      { capability_name: "github.create_release", outcome: "denied" },
      "github.create_release denied",
    ],
  ])("labels %s from its receipt metadata", (eventType, payload, label) => {
    expect(
      ledgerFrameSummary(
        mapAttemptEventReadRow(
          eventRow({ event_type: eventType, payload_inline: payload }),
        ),
      ),
    ).toBe(label);
  });

  it("labels an encrypted payload by its event type only", () => {
    const event = mapAttemptEventReadRow(
      eventRow({
        payload_inline: null,
        encrypted_payload_ref: "evb_0123456789abcdef",
      }),
    );
    expect(ledgerFrameSummary(event)).toBe("model.call_completed");
    for (const type of Object.keys(LEDGER_FRAME_KINDS))
      expect(ledgerFrameSummary({ ...event, eventType: type })).toBe(type);
    expect(ledgerFrameSummary({ ...event, eventType: "change.recorded" })).toBe(
      "change.recorded",
    );
  });
});

// ---- Wrapped agents -------------------------------------------------------------------

describe("tacho run status", () => {
  it.each([
    ["running", "live"],
    ["aborted", "halted"],
    ["completed", "sealed"],
    ["crashed", "sealed"],
    ["unknown", "sealed"],
  ])("%s → %s", (outcome, expected) => {
    expect(tachoRunStatus(outcome)).toBe(expected);
  });
});

describe("tachoCost", () => {
  it("is client-attested USD micros", () => {
    expect(tachoCost(tachoSession())).toEqual({
      micros: "3120450",
      currency: "USD",
      basis: "client_attested",
    });
  });

  it("is null when the collector saw a model it could not price", () => {
    expect(tachoCost(tachoSession({ hasUnknownModelCost: true }))).toBeNull();
  });

  it("is null when tokens were seen but no cost was reported", () => {
    expect(tachoCost(tachoSession({ totalCostMicros: 0 }))).toBeNull();
  });

  it("is a real zero for a session with no model traffic yet", () => {
    expect(
      tachoCost(
        tachoSession({
          totalCostMicros: 0,
          inputTokens: 0,
          outputTokens: 0,
          hasUnknownModelCost: null,
        }),
      ),
    ).toMatchObject({ micros: "0" });
  });
});

describe("tachoCacheHitRate", () => {
  it("is cache reads over every prompt token class", () => {
    expect(tachoCacheHitRate(tachoSession())).toBeCloseTo(0.75, 10);
  });

  it("is null before any prompt tokens were recorded", () => {
    expect(
      tachoCacheHitRate(
        tachoSession({
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        }),
      ),
    ).toBeNull();
  });
});

describe("toTachoRunRow", () => {
  it("parses a recorded root session through RunRow", () => {
    const read = toTachoRunRow(tachoRecord());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(RunRow.parse(read.value)).toEqual({
      id: "tse_4q8r1t6v3x5z0b2d7h2k9m",
      name: null,
      agentKey: "acme.core.claude-code-mbell",
      operatorId: "prn_7h2k9m4q8r1t6v3x5z0b2d",
      workspaceSlug: "core-platform",
      status: "sealed",
      turns: 6,
      steps: 88,
      frames: 214,
      cost: { micros: "3120450", currency: "USD", basis: "client_attested" },
      tier: "harness",
      grade: "inspect",
      verdict: null,
      taskRef: null,
      startedAt: "2026-09-11T10:00:00.000Z",
      sealedAt: "2026-09-11T10:42:13.000Z",
    });
  });

  it("shows a grade outside the spec vocabulary as not recorded", () => {
    const read = toTachoRunRow(tachoRecord({}, { replayGrade: "full" }));
    expect(read.ok && read.value.grade).toBeNull();
    const none = toTachoRunRow(tachoRecord({}, { replayGrade: null }));
    expect(none.ok && none.value.grade).toBeNull();
  });

  it("is not backed (G6) without an operator: ingest does not record one", () => {
    expect(toTachoRunRow(tachoRecord({ operatorPublicId: null }))).toEqual(
      nb("M1", "G6"),
    );
  });

  it("is not backed (G6) for an agent key outside org_ns.ws_ns.slug", () => {
    expect(toTachoRunRow(tachoRecord({}, { agentKey: "claude-code" }))).toEqual(
      nb("M1", "G6"),
    );
  });

  it("is not backed (G3) when the cost is incomplete", () => {
    expect(
      toTachoRunRow(tachoRecord({}, { hasUnknownModelCost: true })),
    ).toEqual(nb("M2", "G3"));
  });

  it("answers run_record_invalid when a recorded value breaks RunRow", () => {
    expect(
      toTachoRunRow(tachoRecord({ workspaceSlug: "Core Platform" })),
    ).toMatchObject({ code: RUN_RECORD_INVALID });
  });
});

describe("toTachoRunDetail", () => {
  it("parses a recorded session through RunDetail with what it touched", () => {
    const read = toTachoRunDetail(tachoRecord(), ["src/release.ts"]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(RunDetail.parse(read.value)).toMatchObject({
      model: "claude-opus-5",
      cacheHitRate: 0.75,
      provenSpend: null,
      productiveRatio: null,
      summary: null,
      touched: ["src/release.ts"],
    });
  });

  it("recorded and none is an empty list, not null", () => {
    const read = toTachoRunDetail(tachoRecord(), []);
    expect(read.ok && read.value.touched).toEqual([]);
  });

  it("falls back to the initial model, and is not backed with neither", () => {
    const initial = toTachoRunDetail(tachoRecord({}, { modelFinal: null }), []);
    expect(initial.ok && initial.value.model).toBe("claude-sonnet-5");
    expect(
      toTachoRunDetail(
        tachoRecord({}, { modelFinal: null, modelInitial: null }),
        [],
      ),
    ).toEqual(nb("M1", "G6"));
  });

  it("is not backed (G3) before any prompt tokens give a hit rate", () => {
    expect(
      toTachoRunDetail(
        tachoRecord(
          {},
          {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalCostMicros: 0,
          },
        ),
        [],
      ),
    ).toEqual(nb("M2", "G3"));
  });

  it("carries the row's own gap and its invalid state through", () => {
    expect(
      toTachoRunDetail(tachoRecord({ operatorPublicId: null }), []),
    ).toEqual(nb("M1", "G6"));
    expect(
      toTachoRunDetail(tachoRecord({ workspaceSlug: "Core Platform" }), []),
    ).toMatchObject({ code: RUN_RECORD_INVALID });
  });
});

// ---- Paging ---------------------------------------------------------------------------

describe("run cursor", () => {
  it("round-trips", () => {
    const cursor = { at: "2026-09-11T10:00:00.000Z", id: "tse_4q8r1t6v" };
    expect(decodeRunCursor(encodeRunCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["not base64 json", "%%%"],
    ["a JSON object", Buffer.from('{"at":"x"}').toString("base64url")],
    [
      "a bad instant",
      Buffer.from('["yesterday","tse_abc"]').toString("base64url"),
    ],
    [
      "a bad id",
      Buffer.from('["2026-09-11T10:00:00Z","drop table"]').toString(
        "base64url",
      ),
    ],
    ["three parts", Buffer.from('["a","b","c"]').toString("base64url")],
  ])("refuses %s", (_label, raw) => {
    expect(decodeRunCursor(raw)).toBeNull();
  });
});

describe("mergeNewestFirst", () => {
  const item = (id: string, startedAt: string) => ({ id, startedAt });

  it("orders newest first and breaks ties on id, descending", () => {
    const a = item("arun_a", "2026-09-11T10:00:00.000Z");
    const b = item("tse_b", "2026-09-11T10:00:00.000Z");
    const c = item("arun_c", "2026-09-11T11:00:00.000Z");
    expect(compareRunsNewestFirst(a, a)).toBe(0);
    const { items, next } = mergeNewestFirst(
      [
        { items: [c, a], overflowed: false },
        { items: [b], overflowed: false },
      ],
      10,
    );
    expect(items.map((i) => i.id)).toEqual(["arun_c", "tse_b", "arun_a"]);
    expect(next).toBeNull();
  });

  it("cuts at the limit and hands a cursor at the last item kept", () => {
    const rows = [
      item("arun_3", "2026-09-11T12:00:00.000Z"),
      item("arun_2", "2026-09-11T11:00:00.000Z"),
    ];
    const { items, next } = mergeNewestFirst(
      [
        { items: rows, overflowed: false },
        {
          items: [item("tse_1", "2026-09-11T10:00:00.000Z")],
          overflowed: false,
        },
      ],
      2,
    );
    expect(items).toHaveLength(2);
    expect(next && decodeRunCursor(next)).toEqual({
      at: "2026-09-11T11:00:00.000Z",
      id: "arun_2",
    });
  });

  it("hands a cursor when a source overflowed even if the merge fits", () => {
    const { next } = mergeNewestFirst(
      [
        {
          items: [item("arun_1", "2026-09-11T10:00:00.000Z")],
          overflowed: true,
        },
      ],
      1,
    );
    expect(next).not.toBeNull();
  });

  it("has no cursor for an empty page", () => {
    expect(mergeNewestFirst([{ items: [], overflowed: false }], 5)).toEqual({
      items: [],
      next: null,
    });
  });
});
