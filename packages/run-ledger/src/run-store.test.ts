/**
 * Unit coverage for run-store.ts — the evidence ledger (ADR-041). No live
 * database: pure SQL builders and row mappers are asserted directly, and the
 * `RunStore` methods run against a fake `tx.execute` injected through
 * @oxagen/database's `makeWithTenantDbMock` test double (a real export, not a
 * `vi.mock`'d one) via a mocked `@oxagen/database` module. Captured SQL is
 * compiled to `{ sql, params }` with the real PgDialect, so assertions are
 * robust to drizzle internals.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: mocks.withTenantDb };
});

import { makeWithTenantDbMock } from "@oxagen/database";
import {
  DEFAULT_READ_EVENTS_LIMIT,
  EVENT_SEQUENCE_CONFLICT_EVENT,
  ATTEMPT_TERMINAL_STATUSES,
  createPostgresRunStore,
  generateRunPublicId,
  generateAttemptPublicId,
  buildRunRowIdentityFromSpec,
  mapRunV2IdentityRow,
  mapRunSummaryRow,
  mapAttemptRow,
  mapAttemptEventReadRow,
  prepareAttemptEvent,
  planAttemptBatch,
  reconcileReplayedEvents,
  foldAttemptStreamDigest,
  foldAttemptEventState,
  attemptRejectionReason,
  assertAttemptWritable,
  runStatusForTerminal,
  buildCreateRunSql,
  buildLockRunForAttemptSql,
  buildInsertAttemptSql,
  buildMarkRunAttemptedSql,
  buildLockAttemptForWriteSql,
  buildSelectAttemptEventStateSql,
  buildAllocateRunSeqSql,
  buildInsertAttemptEventsSql,
  buildInsertAttemptSealSql,
  buildFinishRunSql,
  buildGetRunByPublicIdSql,
  buildListRunAttemptsSql,
  buildListAttemptIdentitySql,
  buildReadAttemptEventsSinceSql,
  type AttemptEventStateRow,
  type AttemptRow,
  type LockedAttemptRow,
  type PreparedAttemptEvent,
  type RunSecurityEventSink,
  type RunSummaryRow,
  type RunV2IdentityRow,
} from "./run-store";
import {
  EMPTY_EVENT_STREAM_DIGEST,
  EVENT_SCHEMA_VERSION,
  MAX_INLINE_PAYLOAD_BYTES,
  advanceEventStreamDigest,
} from "./event-payload-registry";
import {
  FINALIZATION_GRANT_CAPABILITY,
  generateFinalizationGrantPublicId,
} from "./finalization-grant";
import { parseRunSpecV2, type RunSpecV2 } from "./run-spec-v2";
import {
  AttemptNotWritableError,
  ForbiddenEventPayloadFieldError,
  RunEventIntegrityError,
  RunEventPayloadTooLargeError,
  RunEventSequenceGapError,
  RunSpecIdentityMismatchError,
  RunStoreStateError,
  UnknownRunEventTypeError,
  isAttemptNotWritableError,
  isForbiddenEventPayloadFieldError,
  isRunEventIntegrityError,
  isRunEventPayloadTooLargeError,
  isRunEventSequenceGapError,
  isRunStoreStateError,
  isUnknownRunEventTypeError,
} from "./run-errors";

const dialect = new PgDialect();
function compile(query: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(query);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const UUID_ORG = "11111111-1111-4111-8111-111111111111";
const UUID_WS = "22222222-2222-4222-8222-222222222222";
const UUID_RUN = "33333333-3333-4333-8333-333333333333";
const UUID_ATTEMPT = "44444444-4444-4444-8444-444444444444";
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const UUID_D = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const UUID_E = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const UUID_F = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SHA_1 = `sha256:${"1".repeat(64)}`;
const SHA_2 = `sha256:${"2".repeat(64)}`;
const SHA_3 = `sha256:${"3".repeat(64)}`;
const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const ATTEMPT_PUBLIC_ID = "arat_0123456789abcdef0123";
const PRIOR_ATTEMPT_PUBLIC_ID = "arat_fedcba98765432100000";
const BLOB_REF = "evb_0123456789abcdef0123";
const DECISION_REF = "azd_0123456789abcdef0123";
const OBSERVED_AT = "2026-07-21T12:00:00.000Z";

const ENGINE = {
  name: "stella",
  version: "2.1.1",
  buildDigest: SHA_1,
} as const;

function makeSpec(overrides: Record<string, unknown> = {}): RunSpecV2 {
  return parseRunSpecV2({
    version: 2,
    run_kind: "repo_edit",
    goal: "add a health check route",
    engine_policy: {
      requested_engine: "stella",
      allowed_engine_versions: ["2.1.1"],
      model_policy_ref: "default",
      max_steps: 64,
      max_attempts: 3,
    },
    actor_binding: {
      initiating_principal_id: UUID_A,
      agent_principal_id: UUID_B,
      agent_id: UUID_C,
      agent_version_id: UUID_D,
      agent_version_checksum: SHA_1,
    },
    authorization_snapshot_ref: {
      snapshot_id: UUID_E,
      snapshot_digest: SHA_2,
      grant_ceiling_digest: SHA_3,
      deny_generation_at_admission: { org: "7", workspace: "3" },
      resolved_at: OBSERVED_AT,
    },
    repository_binding: {
      repository_binding_public_id: "rpb_0123456789abcdef0123",
      provider: "github",
      provider_repository_id: "987654",
      connection_id: UUID_F,
      configured_default_ref: "main",
      base_commit_sha: COMMIT_SHA,
      base_tree_sha: TREE_SHA,
    },
    workspace_policy: { sandbox_required: true },
    context_policy: {
      provider_allowlist: ["knowledge_graph"],
      max_frames: 32,
      max_tokens: 100_000,
      retention_policy_id: "rpv_0123456789abcdef0123",
      retention_policy_digest: SHA_2,
    },
    tool_policy: { allowlist: ["edit_repo_file"], risk_ceiling: "high" },
    output_policy: { open_pull_request: true },
    ...overrides,
  });
}

/** The same spec, narrowed to a general (non-repository) run. */
function makeGeneralSpec(): RunSpecV2 {
  const {
    repository_binding: _repository,
    output_policy: _output,
    ...rest
  } = makeSpec() as unknown as Record<string, unknown>;
  return parseRunSpecV2({ ...rest, run_kind: "general" });
}

/** The typed columns a run row returns, matching `makeSpec()` exactly. */
function makeIdentityRow(
  overrides: Partial<RunV2IdentityRow> = {},
): RunV2IdentityRow {
  return {
    spec_version: 2,
    run_kind: "repo_edit",
    spec_digest: buildRunRowIdentityFromSpec(makeSpec()).spec_digest,
    initiating_principal_id: UUID_A,
    agent_principal_id: UUID_B,
    agent_id: UUID_C,
    agent_version_id: UUID_D,
    agent_version_checksum: SHA_1,
    authorization_snapshot_id: UUID_E,
    parent_run_id: null,
    repository_binding_id: "55555555-5555-4555-8555-555555555555",
    repository_binding_public_id: "rpb_0123456789abcdef0123",
    repository_provider: "github",
    provider_repository_id: "987654",
    repository_connection_id: UUID_F,
    configured_default_ref: "main",
    base_commit_sha: COMMIT_SHA,
    base_tree_sha: TREE_SHA,
    retention_policy_id: "66666666-6666-4666-8666-666666666666",
    retention_policy_public_id: "rpv_0123456789abcdef0123",
    retention_policy_digest: SHA_2,
    max_attempts: 3,
    ...overrides,
  };
}

function makeCreateRunInput() {
  return {
    orgId: UUID_ORG,
    workspaceId: UUID_WS,
    surface: "repo-edit" as const,
    spec: makeSpec(),
    retentionPolicyRowId: "66666666-6666-4666-8666-666666666666",
    repositoryBindingRowId: "55555555-5555-4555-8555-555555555555",
  };
}

function makeAttemptRow(
  overrides: Partial<LockedAttemptRow> = {},
): LockedAttemptRow {
  return {
    attempt_id: UUID_ATTEMPT,
    attempt_public_id: ATTEMPT_PUBLIC_ID,
    run_id: UUID_RUN,
    org_id: UUID_ORG,
    workspace_id: UUID_WS,
    attempt_number: 1,
    seal_id: null,
    ...overrides,
  };
}

function toolEvent(attemptSeq: number, callId = "call_1") {
  return {
    attemptSeq,
    eventType: "tool.call_completed",
    observedAt: OBSERVED_AT,
    payload: {
      tool_call_id: callId,
      capability_name: "edit_repo_file",
      outcome: "completed" as const,
      input_digest: SHA_1,
      authorization_decision_ref: DECISION_REF,
      duration_ms: 5,
    },
  };
}

function terminalEvent(attemptSeq: number) {
  return {
    attemptSeq,
    eventType: "terminal.attempt_terminated",
    observedAt: OBSERVED_AT,
    payload: { terminal_status: "completed" as const },
  };
}

/** A durable event row shaped exactly as `prepareAttemptEvent` produced it. */
function durableRow(
  prepared: PreparedAttemptEvent,
  id: string,
  runSeq: string,
): AttemptEventStateRow {
  return {
    id,
    attempt_seq: prepared.attemptSeq,
    run_seq: runSeq,
    event_schema_version: prepared.eventSchemaVersion,
    event_type: prepared.eventType,
    payload_digest: prepared.payloadDigest,
    event_digest: prepared.eventDigest,
  };
}

/**
 * A fake `tx.execute` that routes on the COMPILED SQL text rather than call
 * order. Statement order inside one transaction is an implementation detail;
 * routing keeps these tests asserting behavior instead of a call sequence.
 */
type Route = { match: RegExp; rows: unknown[] | (() => unknown[]) };

function makeRoutingTx(routes: Route[]) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn((query: unknown) => {
    const compiled = compile(query as SQL);
    executed.push(compiled);
    for (const route of routes) {
      if (route.match.test(compiled.sql)) {
        const rows =
          typeof route.rows === "function" ? route.rows() : route.rows;
        return Promise.resolve(rows);
      }
    }
    return Promise.resolve([]);
  });
  return { tx: { execute }, executed, execute };
}

function ranSql(
  executed: Array<{ sql: string; params: unknown[] }>,
  pattern: RegExp,
): boolean {
  return executed.some((e) => pattern.test(e.sql));
}

const CREATE_RUN = /INSERT INTO agent\.agent_runs/;
const LOCK_RUN = /SELECT id, org_id, workspace_id, spec_version/;
const INSERT_ATTEMPT = /INSERT INTO agent\.agent_run_attempts/;
const MARK_ATTEMPTED = /attempt_count = attempt_count \+ 1/;
const LOCK_ATTEMPT = /JOIN locked lk ON lk\.id = a\.run_id/;
const ATTEMPT_STATE = /ORDER BY attempt_seq ASC/;
const ALLOCATE_RUN_SEQ = /next_run_seq = next_run_seq \+/;
const INSERT_EVENTS = /INSERT INTO agent\.agent_run_events/;
const INSERT_SEAL = /INSERT INTO agent\.agent_run_attempt_seals/;
const INSERT_GRANT = /INSERT INTO agent\.agent_run_finalization_grants/;
const INSERT_OBLIGATION =
  /INSERT INTO agent\.agent_run_finalization_obligations/;
const SELECT_HANDLE = /JOIN agent\.agent_run_finalization_grants g/;
const FINISH_RUN = /active_attempt_id = NULL/;
const GET_RUN = /WHERE public_id = /;
const LIST_ATTEMPTS = /ORDER BY a\.attempt_number ASC/;
const READ_EVENTS = /ORDER BY e\.run_seq ASC/;
const ATTEMPT_IDENTITY = /SELECT id AS attempt_id/;

function useTx(tx: { execute: unknown }) {
  mocks.withTenantDb.mockImplementation(makeWithTenantDbMock(tx));
}

// ── Public ids ───────────────────────────────────────────────────────────────

describe("public id generation", () => {
  it("mints arat_, afg_ and arun_ ids with the house shape", () => {
    expect(generateRunPublicId()).toMatch(/^arun_[0-9a-f]{22}$/);
    expect(generateAttemptPublicId()).toMatch(/^arat_[0-9a-f]{22}$/);
    expect(generateFinalizationGrantPublicId()).toMatch(/^afg_[0-9a-f]{22}$/);
  });

  it("does not repeat", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => generateRunPublicId()),
    );
    expect(ids.size).toBe(50);
  });
});

// ── Row mappers ──────────────────────────────────────────────────────────────

describe("mapRunSummaryRow", () => {
  const base: RunSummaryRow = {
    id: UUID_RUN,
    public_id: "arun_0123456789abcdef0123",
    surface: "repo-edit",
    spec_version: 2,
    status: "running",
    result: null,
    error: null,
    attempt_count: "2",
    max_attempts: "3",
    created_at: "2026-07-21T12:00:00.000Z",
    started_at: "2026-07-21T12:00:01.000Z",
    completed_at: null,
  };

  it("projects a v2 run, coercing driver-typed numerics and dates", () => {
    const summary = mapRunSummaryRow(base);
    expect(summary).toMatchObject({
      runId: UUID_RUN,
      surface: "repo-edit",
      specVersion: 2,
      status: "running",
      attemptCount: 2,
      maxAttempts: 3,
      completedAt: null,
    });
    expect(summary.createdAt).toBeInstanceOf(Date);
    expect(summary.startedAt).toBeInstanceOf(Date);
  });

  it("reads anything that is not exactly 2 as legacy v1", () => {
    expect(mapRunSummaryRow({ ...base, spec_version: 1 }).specVersion).toBe(1);
    expect(mapRunSummaryRow({ ...base, spec_version: null }).specVersion).toBe(
      1,
    );
    const { spec_version: _omitted, ...withoutColumn } = base;
    expect(mapRunSummaryRow(withoutColumn).specVersion).toBe(1);
  });

  it("carries a null max_attempts through instead of coercing it to 0", () => {
    expect(mapRunSummaryRow({ ...base, max_attempts: null }).maxAttempts).toBe(
      null,
    );
  });

  it("passes Date instances through untouched", () => {
    const createdAt = new Date("2026-07-21T12:00:00.000Z");
    expect(mapRunSummaryRow({ ...base, created_at: createdAt }).createdAt).toBe(
      createdAt,
    );
  });
});

describe("mapAttemptRow", () => {
  const base: AttemptRow = {
    id: UUID_ATTEMPT,
    public_id: ATTEMPT_PUBLIC_ID,
    run_id: UUID_RUN,
    attempt_number: "1",
    worker_id: "drain-1",
    engine_name: "stella",
    engine_version: "2.1.1",
    engine_build_digest: SHA_1,
    resumed_from_attempt_id: null,
    resumed_from_attempt_public_id: null,
    claimed_at: "2026-07-21T12:00:00.000Z",
    seal_id: null,
    terminal_status: null,
    reason_code: null,
    event_count: null,
    final_run_seq: null,
    final_attempt_seq: null,
    final_event_digest: null,
    event_stream_digest: null,
    sealed_at: null,
  };

  it("projects an open attempt with no seal and no provenance", () => {
    const record = mapAttemptRow(base);
    expect(record).toMatchObject({
      attemptId: UUID_ATTEMPT,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      attemptNumber: 1,
      producerId: "drain-1",
      resumedFrom: null,
      seal: null,
    });
    expect(record.engine).toEqual({
      name: "stella",
      version: "2.1.1",
      buildDigest: SHA_1,
    });
  });

  it("projects the attempt-provenance pair when both halves are present", () => {
    expect(
      mapAttemptRow({
        ...base,
        resumed_from_attempt_id: UUID_A,
        resumed_from_attempt_public_id: PRIOR_ATTEMPT_PUBLIC_ID,
      }).resumedFrom,
    ).toEqual({
      attemptId: UUID_A,
      attemptPublicId: PRIOR_ATTEMPT_PUBLIC_ID,
    });
  });

  it("refuses a half-present provenance pair rather than inventing one", () => {
    expect(
      mapAttemptRow({ ...base, resumed_from_attempt_id: UUID_A }).resumedFrom,
    ).toBeNull();
  });

  it("projects a sealed attempt's terminal record", () => {
    const record = mapAttemptRow({
      ...base,
      seal_id: "seal-1",
      terminal_status: "completed",
      reason_code: null,
      event_count: "2",
      final_run_seq: "9",
      final_attempt_seq: "2",
      final_event_digest: SHA_2,
      event_stream_digest: SHA_3,
      sealed_at: "2026-07-21T12:05:00.000Z",
    });
    expect(record.seal).toMatchObject({
      sealId: "seal-1",
      terminalStatus: "completed",
      eventCount: 2,
      finalRunSeq: "9",
      finalAttemptSeq: 2,
      finalEventDigest: SHA_2,
      eventStreamDigest: SHA_3,
    });
  });

  it("projects a zero-event seal with a null final-event digest", () => {
    const record = mapAttemptRow({
      ...base,
      seal_id: "seal-1",
      terminal_status: "abandoned",
      reason_code: "producer_gone",
      event_count: 0,
      event_stream_digest: EMPTY_EVENT_STREAM_DIGEST,
      sealed_at: "2026-07-21T12:05:00.000Z",
    });
    expect(record.seal).toMatchObject({
      eventCount: 0,
      finalRunSeq: null,
      finalAttemptSeq: null,
      finalEventDigest: null,
      reasonCode: "producer_gone",
      eventStreamDigest: EMPTY_EVENT_STREAM_DIGEST,
    });
  });
});

describe("mapAttemptEventReadRow", () => {
  it("carries run_seq as an exact decimal string, never a number", () => {
    const record = mapAttemptEventReadRow({
      id: "event-1",
      attempt_id: UUID_ATTEMPT,
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      run_seq: "9007199254740993",
      attempt_seq: "4",
      event_schema_version: EVENT_SCHEMA_VERSION,
      event_type: "tool.call_completed",
      stage: "tool",
      payload_digest: SHA_1,
      event_digest: SHA_2,
      payload_inline: { tool_call_id: "call_1" },
      encrypted_payload_ref: null,
      observed_at: OBSERVED_AT,
      created_at: "2026-07-21T12:00:02.000Z",
    });
    expect(record.runSeq).toBe("9007199254740993");
    expect(record.attemptSeq).toBe(4);
    expect(record.payload).toEqual({ tool_call_id: "call_1" });
    expect(record.encryptedPayloadRef).toBeNull();
    expect(record.observedAt).toBeInstanceOf(Date);
    expect(record.recordedAt).toBeInstanceOf(Date);
  });

  it("projects an encrypted-reference row with a null inline payload", () => {
    const record = mapAttemptEventReadRow({
      id: "event-2",
      attempt_id: UUID_ATTEMPT,
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      run_seq: "2",
      attempt_seq: 2,
      event_schema_version: EVENT_SCHEMA_VERSION,
      event_type: "model.call_completed",
      stage: "model",
      payload_digest: SHA_1,
      event_digest: SHA_2,
      payload_inline: null,
      encrypted_payload_ref: BLOB_REF,
      observed_at: new Date(OBSERVED_AT),
      created_at: new Date(OBSERVED_AT),
    });
    expect(record.payload).toBeNull();
    expect(record.encryptedPayloadRef).toBe(BLOB_REF);
  });
});

describe("buildRunRowIdentityFromSpec / mapRunV2IdentityRow", () => {
  it("agree field for field on a repo_edit spec", () => {
    expect(mapRunV2IdentityRow(makeIdentityRow())).toEqual(
      buildRunRowIdentityFromSpec(makeSpec()),
    );
  });

  it("nulls every repository field for a general run", () => {
    const identity = buildRunRowIdentityFromSpec(makeGeneralSpec());
    expect(identity.repository_binding_public_id).toBeNull();
    expect(identity.provider).toBeNull();
    expect(identity.base_commit_sha).toBeNull();
  });

  it("maps a missing joined public id to the empty string, never a uuid", () => {
    // The join is the verification; an unmatched binding row must not silently
    // pass the internal uuid off as the public id the spec pinned.
    const mapped = mapRunV2IdentityRow(
      makeIdentityRow({ retention_policy_public_id: null }),
    );
    expect(mapped.retention_policy_id).toBe("");
  });
});

// ── Event preparation ────────────────────────────────────────────────────────

describe("prepareAttemptEvent", () => {
  it("validates an inline payload and derives both digests", () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    expect(prepared.stage).toBe("tool");
    expect(prepared.eventSchemaVersion).toBe(EVENT_SCHEMA_VERSION);
    expect(prepared.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.eventDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(prepared.encryptedPayloadRef).toBeNull();
  });

  it("accepts an encrypted reference with a caller-supplied payload digest", () => {
    const prepared = prepareAttemptEvent({
      attemptSeq: 1,
      eventType: "model.call_completed",
      observedAt: OBSERVED_AT,
      encryptedPayloadRef: BLOB_REF,
      payloadDigest: SHA_1,
    });
    expect(prepared.payload).toBeNull();
    expect(prepared.encryptedPayloadRef).toBe(BLOB_REF);
    expect(prepared.payloadDigest).toBe(SHA_1);
  });

  it("refuses both an inline payload and an encrypted reference", () => {
    const err = (() => {
      try {
        prepareAttemptEvent({
          ...toolEvent(1),
          encryptedPayloadRef: BLOB_REF,
          payloadDigest: SHA_1,
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(isRunStoreStateError(err)).toBe(true);
    expect(err).toBeInstanceOf(RunStoreStateError);
  });

  it("refuses neither", () => {
    expect(() =>
      prepareAttemptEvent({
        attemptSeq: 1,
        eventType: "tool.call_completed",
        observedAt: OBSERVED_AT,
      }),
    ).toThrow(RunStoreStateError);
  });

  it("refuses an event type outside the closed registry", () => {
    const err = (() => {
      try {
        prepareAttemptEvent({
          attemptSeq: 1,
          eventType: "tool.made_up",
          observedAt: OBSERVED_AT,
          payload: {},
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnknownRunEventTypeError);
    expect(isUnknownRunEventTypeError(err)).toBe(true);
  });

  it("refuses a raw content field smuggled into an inline payload", () => {
    const err = (() => {
      try {
        prepareAttemptEvent({
          ...toolEvent(1),
          payload: { ...toolEvent(1).payload, stdout: "secret" },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ForbiddenEventPayloadFieldError);
    expect(isForbiddenEventPayloadFieldError(err)).toBe(true);
  });

  it("refuses an oversized inline payload", () => {
    const err = (() => {
      try {
        prepareAttemptEvent({
          attemptSeq: 1,
          eventType: "checkout.unavailable",
          observedAt: OBSERVED_AT,
          payload: {
            reason_code: "sandbox_unavailable",
            provider_repository_id: "y".repeat(MAX_INLINE_PAYLOAD_BYTES + 1),
          },
        });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RunEventPayloadTooLargeError);
    expect(isRunEventPayloadTooLargeError(err)).toBe(true);
  });

  it("changes the event digest when observed_at is re-stamped", () => {
    const first = prepareAttemptEvent(toolEvent(1));
    const second = prepareAttemptEvent({
      ...toolEvent(1),
      observedAt: "2026-07-21T12:00:05.000Z",
    });
    expect(second.eventDigest).not.toBe(first.eventDigest);
  });
});

// ── Batch planning ───────────────────────────────────────────────────────────

describe("planAttemptBatch", () => {
  const prepared = (seqs: number[]) =>
    seqs.map((seq) => prepareAttemptEvent(toolEvent(seq, `call_${seq}`)));

  it("returns an empty plan for an empty batch", () => {
    expect(planAttemptBatch(UUID_ATTEMPT, 0, [])).toEqual({
      replays: [],
      appends: [],
    });
  });

  it("treats a contiguous batch past the durable tail as all appends", () => {
    const plan = planAttemptBatch(UUID_ATTEMPT, 2, prepared([3, 4]));
    expect(plan.replays).toHaveLength(0);
    expect(plan.appends.map((e) => e.attemptSeq)).toEqual([3, 4]);
  });

  it("splits a crash retry into replays and appends", () => {
    const plan = planAttemptBatch(UUID_ATTEMPT, 2, prepared([1, 2, 3]));
    expect(plan.replays.map((e) => e.attemptSeq)).toEqual([1, 2]);
    expect(plan.appends.map((e) => e.attemptSeq)).toEqual([3]);
  });

  it("refuses a batch that skips ahead of the durable tail", () => {
    const err = (() => {
      try {
        planAttemptBatch(UUID_ATTEMPT, 1, prepared([3]));
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RunEventSequenceGapError);
    expect(isRunEventSequenceGapError(err)).toBe(true);
    expect((err as RunEventSequenceGapError).expectedSeq).toBe(2);
  });

  it("refuses a batch that is not internally contiguous", () => {
    expect(() => planAttemptBatch(UUID_ATTEMPT, 4, prepared([5, 7]))).toThrow(
      RunEventSequenceGapError,
    );
  });

  it("refuses a non-positive sequence", () => {
    expect(() => planAttemptBatch(UUID_ATTEMPT, 0, prepared([0]))).toThrow(
      RunEventSequenceGapError,
    );
  });
});

describe("reconcileReplayedEvents", () => {
  const first = prepareAttemptEvent(toolEvent(1));

  it("returns the prior rows unchanged when every digest matches", () => {
    const out = reconcileReplayedEvents(
      UUID_ATTEMPT,
      [first],
      [durableRow(first, "event-1", "7")],
    );
    expect(out).toEqual([
      {
        attemptSeq: 1,
        runSeq: "7",
        eventId: "event-1",
        eventDigest: first.eventDigest,
        idempotent: true,
      },
    ]);
  });

  it("raises an integrity conflict on a same-seq different-digest replay", () => {
    const err = (() => {
      try {
        reconcileReplayedEvents(
          UUID_ATTEMPT,
          [first],
          [{ ...durableRow(first, "event-1", "7"), event_digest: SHA_3 }],
        );
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RunEventIntegrityError);
    expect(isRunEventIntegrityError(err)).toBe(true);
    expect((err as RunEventIntegrityError).storedDigest).toBe(SHA_3);
  });

  it("refuses to reconcile a sequence with no durable row", () => {
    expect(() => reconcileReplayedEvents(UUID_ATTEMPT, [first], [])).toThrow(
      RunStoreStateError,
    );
  });
});

describe("foldAttemptStreamDigest", () => {
  it("is the empty sentinel for no appended events", () => {
    expect(foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, [])).toBe(
      EMPTY_EVENT_STREAM_DIGEST,
    );
  });

  it("reproduces advanceEventStreamDigest applied in order", () => {
    const events = [1, 2].map((seq) =>
      prepareAttemptEvent(toolEvent(seq, `call_${seq}`)),
    );
    const expected = events.reduce(
      (digest, e) =>
        advanceEventStreamDigest(digest, {
          attemptSeq: e.attemptSeq,
          eventSchemaVersion: e.eventSchemaVersion,
          eventType: e.eventType,
          payloadDigest: e.payloadDigest,
        }),
      EMPTY_EVENT_STREAM_DIGEST,
    );
    expect(foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, events)).toBe(
      expected,
    );
  });
});

describe("foldAttemptEventState", () => {
  it("returns the canonical empty state for a zero-event attempt", () => {
    expect(foldAttemptEventState(UUID_ATTEMPT, [])).toEqual({
      eventCount: 0,
      lastAttemptSeq: 0,
      lastRunSeq: "0",
      finalEventDigest: null,
      eventStreamDigest: EMPTY_EVENT_STREAM_DIGEST,
    });
  });

  it("folds the durable log into the same digest an append would produce", () => {
    const events = [1, 2].map((seq) =>
      prepareAttemptEvent(toolEvent(seq, `call_${seq}`)),
    );
    const state = foldAttemptEventState(UUID_ATTEMPT, [
      durableRow(events[0] as PreparedAttemptEvent, "event-1", "5"),
      durableRow(events[1] as PreparedAttemptEvent, "event-2", "6"),
    ]);
    expect(state).toEqual({
      eventCount: 2,
      lastAttemptSeq: 2,
      lastRunSeq: "6",
      finalEventDigest: (events[1] as PreparedAttemptEvent).eventDigest,
      eventStreamDigest: foldAttemptStreamDigest(
        EMPTY_EVENT_STREAM_DIGEST,
        events,
      ),
    });
  });

  it("refuses to summarize a log with a hole in it", () => {
    const events = [1, 3].map((seq) =>
      prepareAttemptEvent(toolEvent(seq, `call_${seq}`)),
    );
    expect(() =>
      foldAttemptEventState(UUID_ATTEMPT, [
        durableRow(events[0] as PreparedAttemptEvent, "event-1", "5"),
        durableRow(events[1] as PreparedAttemptEvent, "event-3", "7"),
      ]),
    ).toThrow(RunStoreStateError);
  });
});

// ── Write gate ───────────────────────────────────────────────────────────────

describe("attemptRejectionReason / assertAttemptWritable", () => {
  it("admits an open attempt", () => {
    expect(attemptRejectionReason(makeAttemptRow())).toBeNull();
    expect(assertAttemptWritable(UUID_ATTEMPT, makeAttemptRow())).toMatchObject(
      { attempt_id: UUID_ATTEMPT },
    );
  });

  it("refuses an attempt that does not exist", () => {
    expect(attemptRejectionReason(undefined)).toBe("unknown_attempt");
    const err = (() => {
      try {
        assertAttemptWritable(UUID_ATTEMPT, undefined);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AttemptNotWritableError);
    expect(isAttemptNotWritableError(err)).toBe(true);
    expect((err as AttemptNotWritableError).reason).toBe("unknown_attempt");
  });

  it("refuses a sealed attempt — the seal is the fence", () => {
    const row = makeAttemptRow({ seal_id: "seal-1" });
    expect(attemptRejectionReason(row)).toBe("sealed");
    expect(() => assertAttemptWritable(UUID_ATTEMPT, row)).toThrow(
      AttemptNotWritableError,
    );
  });
});

describe("runStatusForTerminal", () => {
  it("maps every terminal status to a run status, failing closed", () => {
    expect(runStatusForTerminal("completed")).toBe("completed");
    expect(runStatusForTerminal("cancelled")).toBe("cancelled");
    expect(runStatusForTerminal("failed")).toBe("failed");
    // A denial and an abandonment are failures of the RUN; the denial itself is
    // evidence on the sealed attempt, not a separate run status.
    expect(runStatusForTerminal("denied")).toBe("failed");
    expect(runStatusForTerminal("abandoned")).toBe("failed");
  });

  it("covers every declared terminal status", () => {
    for (const status of ATTEMPT_TERMINAL_STATUSES) {
      expect(["completed", "failed", "cancelled"]).toContain(
        runStatusForTerminal(status),
      );
    }
  });
});

// ── SQL builders ─────────────────────────────────────────────────────────────

describe("SQL builders", () => {
  it("buildCreateRunSql writes spec_version 2 and joins both bindings back", () => {
    const { sql: text, params } = compile(
      buildCreateRunSql("arun_x", SHA_1, makeCreateRunInput()),
    );
    expect(text).toContain("INSERT INTO agent.agent_runs");
    expect(text).toContain(
      "LEFT JOIN ingestion.repository_bindings rb ON rb.id = i.repository_binding_id",
    );
    expect(text).toContain(
      "LEFT JOIN evidence.retention_policy_versions rpv ON rpv.id = i.retention_policy_id",
    );
    expect(params).toContain("arun_x");
    expect(params).toContain(SHA_1);
    // The identity is written from the SPEC, never from a caller-supplied copy.
    expect(params).toContain(UUID_A);
    expect(params).toContain(COMMIT_SHA);
  });

  it("buildLockRunForAttemptSql takes the run row's FOR UPDATE lock", () => {
    const { sql: text, params } = compile(buildLockRunForAttemptSql(UUID_RUN));
    expect(text).toContain("FROM agent.agent_runs");
    expect(text).toContain("FOR UPDATE");
    expect(params).toEqual([UUID_RUN]);
  });

  it("buildInsertAttemptSql writes the narrowed attempt-provenance pair only", () => {
    const { sql: text, params } = compile(
      buildInsertAttemptSql({
        publicId: ATTEMPT_PUBLIC_ID,
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        runId: UUID_RUN,
        attemptNumber: 2,
        producerId: "drain-1",
        engine: ENGINE,
        resumedFrom: {
          attemptId: UUID_A,
          attemptPublicId: PRIOR_ATTEMPT_PUBLIC_ID,
        },
      }),
    );
    expect(text).toContain("INSERT INTO agent.agent_run_attempts");
    expect(text).toContain("resumed_from_attempt_id");
    // The checkpoint half of the old four-part restore tuple is gone (ADR-041).
    expect(text).not.toContain("restored_checkpoint");
    expect(params).toContain(PRIOR_ATTEMPT_PUBLIC_ID);
    expect(params).toContain(ENGINE.buildDigest);
  });

  it("buildInsertAttemptSql nulls both provenance halves for a first attempt", () => {
    const { params } = compile(
      buildInsertAttemptSql({
        publicId: ATTEMPT_PUBLIC_ID,
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        runId: UUID_RUN,
        attemptNumber: 1,
        producerId: "drain-1",
        engine: ENGINE,
        resumedFrom: null,
      }),
    );
    expect(params.filter((p) => p === null)).toHaveLength(2);
  });

  it("buildMarkRunAttemptedSql moves only operational columns", () => {
    const { sql: text } = compile(
      buildMarkRunAttemptedSql(UUID_RUN, UUID_ATTEMPT),
    );
    expect(text).toContain("attempt_count = attempt_count + 1");
    expect(text).toContain("active_attempt_id");
    expect(text).toContain("started_at = coalesce(started_at, now())");
    expect(text).not.toContain("spec_digest");
  });

  it("buildLockAttemptForWriteSql locks the RUN row and joins the seal", () => {
    const { sql: text, params } = compile(
      buildLockAttemptForWriteSql(UUID_ATTEMPT),
    );
    expect(text).toContain("FROM agent.agent_runs r");
    expect(text).toContain("FOR UPDATE");
    expect(text).toContain(
      "LEFT JOIN agent.agent_run_attempt_seals s ON s.attempt_id = a.id",
    );
    expect(params).toEqual([UUID_ATTEMPT, UUID_ATTEMPT]);
  });

  it("buildSelectAttemptEventStateSql reads the whole v2 stream in order", () => {
    const { sql: text } = compile(
      buildSelectAttemptEventStateSql(UUID_ATTEMPT),
    );
    expect(text).toContain("event_record_version = 2");
    expect(text).toContain("run_seq::text");
    expect(text).toContain("ORDER BY attempt_seq ASC");
  });

  it("buildAllocateRunSeqSql returns the FIRST reserved sequence as text", () => {
    const { sql: text, params } = compile(buildAllocateRunSeqSql(UUID_RUN, 3));
    expect(text).toContain("next_run_seq = next_run_seq +");
    expect(text).toContain("(next_run_seq - $3)::text AS first_run_seq");
    expect(params).toEqual([3, UUID_RUN, 3]);
  });

  it("buildInsertAttemptEventsSql has NO conflict clause", () => {
    const prepared = [1, 2].map((seq) =>
      prepareAttemptEvent(toolEvent(seq, `call_${seq}`)),
    );
    const query = buildInsertAttemptEventsSql(
      UUID_RUN,
      UUID_ORG,
      UUID_WS,
      UUID_ATTEMPT,
      prepared.map((e, i) => ({ ...e, runSeq: String(i + 5) })),
    );
    const { sql: text, params } = compile(query as SQL);
    expect(text).not.toContain("ON CONFLICT");
    expect(text).toContain("RETURNING id, attempt_seq, run_seq::text");
    expect(params).toContain("5");
    expect(params).toContain("6");
  });

  it("buildInsertAttemptEventsSql returns null for an empty batch", () => {
    expect(
      buildInsertAttemptEventsSql(
        UUID_RUN,
        UUID_ORG,
        UUID_WS,
        UUID_ATTEMPT,
        [],
      ),
    ).toBeNull();
  });

  it("buildInsertAttemptSealSql pins the schema's sealer_kind vocabulary", () => {
    const { sql: text, params } = compile(
      buildInsertAttemptSealSql({
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        runId: UUID_RUN,
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        reasonCode: null,
        eventCount: 2,
        finalRunSeq: "6",
        finalAttemptSeq: 2,
        finalEventDigest: SHA_2,
        eventStreamDigest: SHA_3,
        sealerId: "drain-1",
      }),
    );
    expect(text).toContain("INSERT INTO agent.agent_run_attempt_seals");
    expect(text).toContain("'worker'");
    expect(params).toContain("drain-1");
    expect(params).toContain(SHA_3);
  });

  it("buildFinishRunSql clears the active-attempt pointer", () => {
    const { sql: text, params } = compile(
      buildFinishRunSql(UUID_RUN, "failed", null, "boom"),
    );
    expect(text).toContain("active_attempt_id = NULL");
    expect(text).toContain("completed_at = now()");
    expect(params).toContain("boom");
    // The result column stays NULL rather than being written as the string
    // "null" — a JSON.stringify(null) would be indistinguishable from evidence.
    expect(params).toContain(null);
  });

  it("buildFinishRunSql serializes a result payload", () => {
    const { params } = compile(
      buildFinishRunSql(UUID_RUN, "completed", { ok: true }, null),
    );
    expect(params).toContain('{"ok":true}');
  });

  it("buildGetRunByPublicIdSql has no tenant predicate — RLS scopes it", () => {
    const { sql: text, params } = compile(buildGetRunByPublicIdSql("arun_abc"));
    expect(text).toContain("WHERE public_id =");
    expect(text).not.toContain("org_id =");
    expect(params).toEqual(["arun_abc"]);
  });

  it("buildListRunAttemptsSql orders by attempt_number and joins the seal", () => {
    const { sql: text, params } = compile(buildListRunAttemptsSql(UUID_RUN));
    expect(text).toContain("LEFT JOIN agent.agent_run_attempt_seals");
    expect(text).toContain("ORDER BY a.attempt_number ASC");
    expect(params).toEqual([UUID_RUN]);
  });

  it("buildReadAttemptEventsSinceSql cursors on the bigint run_seq", () => {
    const { sql: text, params } = compile(
      buildReadAttemptEventsSinceSql(UUID_RUN, "12"),
    );
    expect(text).toContain("e.run_seq > $2::bigint");
    expect(text).toContain("ORDER BY e.run_seq ASC");
    expect(params).toEqual([UUID_RUN, "12", DEFAULT_READ_EVENTS_LIMIT]);
  });

  it("buildReadAttemptEventsSinceSql honours an explicit limit", () => {
    expect(
      compile(buildReadAttemptEventsSinceSql(UUID_RUN, "0", 10)).params,
    ).toEqual([UUID_RUN, "0", 10]);
  });

  it("buildListAttemptIdentitySql resolves an attempt without a lock", () => {
    const { sql: text, params } = compile(
      buildListAttemptIdentitySql(UUID_ATTEMPT),
    );
    expect(text).toContain("SELECT id AS attempt_id");
    expect(text).not.toContain("FOR UPDATE");
    expect(params).toEqual([UUID_ATTEMPT]);
  });
});

// ── createRun ────────────────────────────────────────────────────────────────

describe("createRun", () => {
  it("inserts the trusted row and verifies it against the spec", async () => {
    const { tx, executed } = makeRoutingTx([
      {
        match: CREATE_RUN,
        rows: [{ id: UUID_RUN, public_id: "arun_x", ...makeIdentityRow() }],
      },
    ]);
    useTx(tx);
    const result = await createPostgresRunStore().createRun(
      makeCreateRunInput(),
    );
    expect(result.runId).toBe(UUID_RUN);
    expect(result.publicId).toBe("arun_x");
    expect(result.specDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ranSql(executed, CREATE_RUN)).toBe(true);
  });

  it("fails closed when the stored row disagrees with the spec", async () => {
    const { tx } = makeRoutingTx([
      {
        match: CREATE_RUN,
        rows: [
          {
            id: UUID_RUN,
            public_id: "arun_x",
            ...makeIdentityRow({ base_commit_sha: "c".repeat(40) }),
          },
        ],
      },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().createRun(makeCreateRunInput()),
    ).rejects.toBeInstanceOf(RunSpecIdentityMismatchError);
  });

  it("throws when the insert returns no row", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    await expect(
      createPostgresRunStore().createRun(makeCreateRunInput()),
    ).rejects.toBeInstanceOf(RunStoreStateError);
  });
});

// ── createAttempt ────────────────────────────────────────────────────────────

function lockedRunRows(overrides: Record<string, unknown> = {}) {
  return [
    {
      id: UUID_RUN,
      org_id: UUID_ORG,
      workspace_id: UUID_WS,
      spec_version: 2,
      status: "pending",
      attempt_count: 0,
      max_attempts: 3,
      ...overrides,
    },
  ];
}

describe("createAttempt", () => {
  const input = {
    runId: UUID_RUN,
    producerId: "drain-1",
    engine: ENGINE,
  };

  it("creates the immutable attempt and marks the run attempted", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_RUN, rows: lockedRunRows() },
      {
        match: INSERT_ATTEMPT,
        rows: [
          {
            id: UUID_ATTEMPT,
            public_id: ATTEMPT_PUBLIC_ID,
            attempt_number: 1,
          },
        ],
      },
      { match: MARK_ATTEMPTED, rows: [{ id: UUID_RUN, attempt_count: 1 }] },
    ]);
    useTx(tx);
    const attempt = await createPostgresRunStore().createAttempt(input);
    expect(attempt).toEqual({
      attemptId: UUID_ATTEMPT,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      runId: UUID_RUN,
      orgId: UUID_ORG,
      workspaceId: UUID_WS,
      attemptNumber: 1,
      maxAttempts: 3,
      engine: ENGINE,
      resumedFrom: null,
    });
    expect(ranSql(executed, MARK_ATTEMPTED)).toBe(true);
  });

  it("carries the attempt-provenance pair onto a successor", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_RUN, rows: lockedRunRows({ attempt_count: 1 }) },
      {
        match: INSERT_ATTEMPT,
        rows: [{ id: UUID_B, public_id: ATTEMPT_PUBLIC_ID, attempt_number: 2 }],
      },
      { match: MARK_ATTEMPTED, rows: [{ id: UUID_RUN, attempt_count: 2 }] },
    ]);
    useTx(tx);
    const attempt = await createPostgresRunStore().createAttempt({
      ...input,
      resumedFrom: {
        attemptId: UUID_ATTEMPT,
        attemptPublicId: PRIOR_ATTEMPT_PUBLIC_ID,
      },
    });
    expect(attempt.attemptNumber).toBe(2);
    expect(attempt.resumedFrom).toEqual({
      attemptId: UUID_ATTEMPT,
      attemptPublicId: PRIOR_ATTEMPT_PUBLIC_ID,
    });
    const insert = executed.find((e) => INSERT_ATTEMPT.test(e.sql));
    expect(insert?.params).toContain(PRIOR_ATTEMPT_PUBLIC_ID);
  });

  it("refuses an unknown run", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    await expect(createPostgresRunStore().createAttempt(input)).rejects.toThrow(
      /does not exist/,
    );
  });

  it("refuses a preserved legacy run row", async () => {
    const { tx } = makeRoutingTx([
      {
        match: LOCK_RUN,
        rows: lockedRunRows({ spec_version: 1, max_attempts: null }),
      },
    ]);
    useTx(tx);
    await expect(createPostgresRunStore().createAttempt(input)).rejects.toThrow(
      /preserved legacy row/,
    );
  });

  it("refuses to exceed the run's pinned max_attempts", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_RUN, rows: lockedRunRows({ attempt_count: 3 }) },
    ]);
    useTx(tx);
    await expect(createPostgresRunStore().createAttempt(input)).rejects.toThrow(
      /exhausted its pinned max_attempts/,
    );
  });

  it("throws when the attempt insert returns no row", async () => {
    const { tx } = makeRoutingTx([{ match: LOCK_RUN, rows: lockedRunRows() }]);
    useTx(tx);
    await expect(createPostgresRunStore().createAttempt(input)).rejects.toThrow(
      /attempt insert returned no row/,
    );
  });

  it("throws when the run cannot be marked running", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_RUN, rows: lockedRunRows() },
      {
        match: INSERT_ATTEMPT,
        rows: [
          { id: UUID_ATTEMPT, public_id: ATTEMPT_PUBLIC_ID, attempt_number: 1 },
        ],
      },
    ]);
    useTx(tx);
    await expect(createPostgresRunStore().createAttempt(input)).rejects.toThrow(
      /could not be marked running/,
    );
  });
});

// ── appendAttemptBatch ───────────────────────────────────────────────────────

describe("appendAttemptBatch", () => {
  it("appends a contiguous batch and folds the stream digest", async () => {
    const prepared = [1, 2].map((seq) =>
      prepareAttemptEvent(toolEvent(seq, `call_${seq}`)),
    );
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      { match: ALLOCATE_RUN_SEQ, rows: [{ first_run_seq: "5" }] },
      {
        match: INSERT_EVENTS,
        // Deliberately out of order: multi-row RETURNING order is not
        // guaranteed, so the store must match on attempt_seq, not position.
        rows: [
          { id: "event-2", attempt_seq: 2, run_seq: "6" },
          { id: "event-1", attempt_seq: 1, run_seq: "5" },
        ],
      },
    ]);
    useTx(tx);
    const result = await createPostgresRunStore().appendAttemptBatch({
      attemptId: UUID_ATTEMPT,
      events: [toolEvent(1, "call_1"), toolEvent(2, "call_2")],
    });
    expect(result.events.map((e) => e.eventId)).toEqual(["event-1", "event-2"]);
    expect(result.events.every((e) => e.idempotent === false)).toBe(true);
    expect(result.eventCount).toBe(2);
    expect(result.lastAttemptSeq).toBe(2);
    expect(result.lastRunSeq).toBe("6");
    expect(result.eventStreamDigest).toBe(
      foldAttemptStreamDigest(EMPTY_EVENT_STREAM_DIGEST, prepared),
    );
    expect(result.finalEventDigest).toBe(
      (prepared[1] as PreparedAttemptEvent).eventDigest,
    );
    // No pointer table is written: the log is the pointer.
    expect(ranSql(executed, /agent_run_attempt_leases/)).toBe(false);
  });

  it("is idempotent for a fully replayed batch and moves nothing", async () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [durableRow(prepared, "event-1", "5")] },
    ]);
    useTx(tx);
    const result = await createPostgresRunStore().appendAttemptBatch({
      attemptId: UUID_ATTEMPT,
      events: [toolEvent(1)],
    });
    expect(result.events).toEqual([
      {
        attemptSeq: 1,
        runSeq: "5",
        eventId: "event-1",
        eventDigest: prepared.eventDigest,
        idempotent: true,
      },
    ]);
    expect(result.eventCount).toBe(1);
    expect(result.lastRunSeq).toBe("5");
    expect(ranSql(executed, ALLOCATE_RUN_SEQ)).toBe(false);
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
  });

  it("splits a crash retry into a replayed prefix and a new suffix", async () => {
    const first = prepareAttemptEvent(toolEvent(1, "call_1"));
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [durableRow(first, "event-1", "5")] },
      { match: ALLOCATE_RUN_SEQ, rows: [{ first_run_seq: "6" }] },
      {
        match: INSERT_EVENTS,
        rows: [{ id: "event-2", attempt_seq: 2, run_seq: "6" }],
      },
    ]);
    useTx(tx);
    const result = await createPostgresRunStore().appendAttemptBatch({
      attemptId: UUID_ATTEMPT,
      events: [toolEvent(1, "call_1"), toolEvent(2, "call_2")],
    });
    expect(result.events.map((e) => e.idempotent)).toEqual([true, false]);
    expect(result.eventCount).toBe(2);
  });

  it("refuses to append to a sealed attempt", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow({ seal_id: "seal-1" })] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toBeInstanceOf(AttemptNotWritableError);
  });

  it("refuses an unknown attempt", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toBeInstanceOf(AttemptNotWritableError);
  });

  it("validates payloads before any SQL is issued", async () => {
    const { tx, execute } = makeRoutingTx([]);
    useTx(tx);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [
          {
            attemptSeq: 1,
            eventType: "tool.made_up",
            observedAt: OBSERVED_AT,
            payload: {},
          },
        ],
      }),
    ).rejects.toBeInstanceOf(UnknownRunEventTypeError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports a same-seq different-digest conflict to the security sink", async () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      {
        match: ATTEMPT_STATE,
        rows: [
          { ...durableRow(prepared, "event-1", "5"), event_digest: SHA_3 },
        ],
      },
    ]);
    useTx(tx);
    const recordEventSequenceConflict = vi.fn();
    const sink: RunSecurityEventSink = { recordEventSequenceConflict };
    await expect(
      createPostgresRunStore({ securityEvents: sink }).appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toBeInstanceOf(RunEventIntegrityError);
    expect(recordEventSequenceConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        type: EVENT_SEQUENCE_CONFLICT_EVENT,
        orgId: UUID_ORG,
        workspaceId: UUID_WS,
        runId: UUID_RUN,
        attemptId: UUID_ATTEMPT,
        attemptPublicId: ATTEMPT_PUBLIC_ID,
        attemptSeq: 1,
        storedDigest: SHA_3,
        incomingDigest: prepared.eventDigest,
      }),
    );
  });

  it("keeps the integrity error when the sink itself throws", async () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      {
        match: ATTEMPT_STATE,
        rows: [
          { ...durableRow(prepared, "event-1", "5"), event_digest: SHA_3 },
        ],
      },
    ]);
    useTx(tx);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const sink: RunSecurityEventSink = {
      recordEventSequenceConflict: () => {
        throw new Error("audit transport down");
      },
    };
    await expect(
      createPostgresRunStore({ securityEvents: sink }).appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toBeInstanceOf(RunEventIntegrityError);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("falls back to the loud console sink when none is injected", async () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      {
        match: ATTEMPT_STATE,
        rows: [
          { ...durableRow(prepared, "event-1", "5"), event_digest: SHA_3 },
        ],
      },
    ]);
    useTx(tx);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toBeInstanceOf(RunEventIntegrityError);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(EVENT_SEQUENCE_CONFLICT_EVENT),
      expect.objectContaining({ attemptSeq: 1 }),
    );
    consoleError.mockRestore();
  });

  it("throws when the sequence allocator returns nothing", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toThrow(/did not allocate run sequences/);
  });

  it("throws when the insert does not return a row for a sequence", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      { match: ALLOCATE_RUN_SEQ, rows: [{ first_run_seq: "5" }] },
      { match: INSERT_EVENTS, rows: [] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().appendAttemptBatch({
        attemptId: UUID_ATTEMPT,
        events: [toolEvent(1)],
      }),
    ).rejects.toThrow(/was not returned by the insert/);
  });
});

// ── sealAttempt ──────────────────────────────────────────────────────────────

const SEAL_ROUTES: Route[] = [
  { match: INSERT_SEAL, rows: [{ id: "seal-1" }] },
  { match: INSERT_GRANT, rows: [{ id: "grant-1", public_id: "afg_abc" }] },
  { match: INSERT_OBLIGATION, rows: [{ id: "obligation-1" }] },
  { match: FINISH_RUN, rows: [{ id: UUID_RUN }] },
];

describe("sealAttempt", () => {
  it("appends the terminal event, seals, and mints grant + obligation", async () => {
    const prepared = prepareAttemptEvent(terminalEvent(1));
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      { match: ALLOCATE_RUN_SEQ, rows: [{ first_run_seq: "5" }] },
      {
        match: INSERT_EVENTS,
        rows: [{ id: "event-1", attempt_seq: 1, run_seq: "5" }],
      },
      ...SEAL_ROUTES,
    ]);
    useTx(tx);
    const handle = await createPostgresRunStore().sealAttempt({
      attemptId: UUID_ATTEMPT,
      terminalStatus: "completed",
      terminalEvent: terminalEvent(1),
      sealerId: "drain-1",
      result: { ok: true },
    });
    expect(handle).toMatchObject({
      runId: UUID_RUN,
      attemptId: UUID_ATTEMPT,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      sealId: "seal-1",
      terminalStatus: "completed",
      grantId: "grant-1",
      grantPublicId: "afg_abc",
      // The grant's own public id IS the stable submission id.
      submissionId: "afg_abc",
      obligationId: "obligation-1",
      eventCount: 1,
      finalEventDigest: prepared.eventDigest,
      alreadySealed: false,
    });
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("5");
    const grant = executed.find((e) => INSERT_GRANT.test(e.sql));
    expect(grant?.params).toContain(FINALIZATION_GRANT_CAPABILITY);
    expect(ranSql(executed, FINISH_RUN)).toBe(true);
  });

  it("seals a zero-event attempt with the empty-stream sentinel", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      ...SEAL_ROUTES,
    ]);
    useTx(tx);
    const handle = await createPostgresRunStore().sealAttempt({
      attemptId: UUID_ATTEMPT,
      terminalStatus: "abandoned",
      reasonCode: "producer_gone",
      sealerId: "sweeper-1",
    });
    expect(handle.eventCount).toBe(0);
    expect(handle.finalEventDigest).toBeNull();
    expect(handle.eventStreamDigest).toBe(EMPTY_EVENT_STREAM_DIGEST);
    // Nothing was synthesized to make the seal look complete.
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
    const seal = executed.find((e) => INSERT_SEAL.test(e.sql));
    expect(seal?.params).toContain("producer_gone");
    // An abandoned attempt fails its run.
    expect(executed.find((e) => FINISH_RUN.test(e.sql))?.params).toContain(
      "failed",
    );
  });

  it("seals an attempt whose terminal event is already durable", async () => {
    const prepared = prepareAttemptEvent(terminalEvent(1));
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [durableRow(prepared, "event-1", "5")] },
      ...SEAL_ROUTES,
    ]);
    useTx(tx);
    const handle = await createPostgresRunStore().sealAttempt({
      attemptId: UUID_ATTEMPT,
      terminalStatus: "completed",
      sealerId: "drain-1",
    });
    expect(handle.eventCount).toBe(1);
    expect(handle.finalEventDigest).toBe(prepared.eventDigest);
    expect(ranSql(executed, INSERT_EVENTS)).toBe(false);
  });

  it("returns the SAME handle for a duplicate seal", async () => {
    const { tx, executed } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow({ seal_id: "seal-1" })] },
      {
        match: SELECT_HANDLE,
        rows: [
          {
            seal_id: "seal-1",
            terminal_status: "completed",
            event_count: "2",
            final_event_digest: SHA_2,
            event_stream_digest: SHA_3,
            grant_id: "grant-1",
            grant_public_id: "afg_abc",
            obligation_id: "obligation-1",
            submission_id: "afg_abc",
          },
        ],
      },
    ]);
    useTx(tx);
    const handle = await createPostgresRunStore().sealAttempt({
      attemptId: UUID_ATTEMPT,
      terminalStatus: "completed",
      sealerId: "drain-2",
    });
    expect(handle).toMatchObject({
      sealId: "seal-1",
      submissionId: "afg_abc",
      eventCount: 2,
      alreadySealed: true,
    });
    // No second grant is minted and the run is not re-finished.
    expect(ranSql(executed, INSERT_GRANT)).toBe(false);
    expect(ranSql(executed, FINISH_RUN)).toBe(false);
  });

  it("throws when a sealed attempt has no grant or obligation", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow({ seal_id: "seal-1" })] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        sealerId: "drain-1",
      }),
    ).rejects.toThrow(/no finalization grant or obligation/);
  });

  it("refuses a terminal event that is not a terminal-stage event", async () => {
    const { tx, execute } = makeRoutingTx([]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        terminalEvent: toolEvent(1),
        sealerId: "drain-1",
      }),
    ).rejects.toThrow(/is not a terminal-stage event/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses to seal an unknown attempt", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        sealerId: "drain-1",
      }),
    ).rejects.toBeInstanceOf(AttemptNotWritableError);
  });

  it("throws when the seal insert returns no row", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "failed",
        sealerId: "drain-1",
        error: "boom",
      }),
    ).rejects.toThrow(/seal insert returned no row/);
  });

  it("throws when the grant insert returns no row", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      { match: INSERT_SEAL, rows: [{ id: "seal-1" }] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        sealerId: "drain-1",
      }),
    ).rejects.toThrow(/finalization grant insert returned no row/);
  });

  it("throws when the obligation insert returns no row", async () => {
    const { tx } = makeRoutingTx([
      { match: LOCK_ATTEMPT, rows: [makeAttemptRow()] },
      { match: ATTEMPT_STATE, rows: [] },
      { match: INSERT_SEAL, rows: [{ id: "seal-1" }] },
      { match: INSERT_GRANT, rows: [{ id: "grant-1", public_id: "afg_abc" }] },
    ]);
    useTx(tx);
    await expect(
      createPostgresRunStore().sealAttempt({
        attemptId: UUID_ATTEMPT,
        terminalStatus: "completed",
        sealerId: "drain-1",
      }),
    ).rejects.toThrow(/finalization obligation insert returned no row/);
  });
});

// ── Read side ────────────────────────────────────────────────────────────────

describe("read side", () => {
  it("getRunByPublicId projects a found row", async () => {
    const { tx } = makeRoutingTx([
      {
        match: GET_RUN,
        rows: [
          {
            id: UUID_RUN,
            public_id: "arun_x",
            surface: "repo-edit",
            spec_version: 2,
            status: "completed",
            result: { ok: true },
            error: null,
            attempt_count: 1,
            max_attempts: 3,
            created_at: OBSERVED_AT,
            started_at: OBSERVED_AT,
            completed_at: OBSERVED_AT,
          },
        ],
      },
    ]);
    useTx(tx);
    const summary = await createPostgresRunStore().getRunByPublicId("arun_x");
    expect(summary).toMatchObject({ runId: UUID_RUN, status: "completed" });
  });

  it("getRunByPublicId returns null for an unknown or cross-tenant id", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    expect(
      await createPostgresRunStore().getRunByPublicId("arun_missing"),
    ).toBeNull();
  });

  it("listRunAttempts maps every attempt row", async () => {
    const { tx } = makeRoutingTx([
      {
        match: LIST_ATTEMPTS,
        rows: [
          {
            id: UUID_ATTEMPT,
            public_id: ATTEMPT_PUBLIC_ID,
            run_id: UUID_RUN,
            attempt_number: 1,
            worker_id: "drain-1",
            engine_name: "stella",
            engine_version: "2.1.1",
            engine_build_digest: SHA_1,
            resumed_from_attempt_id: null,
            resumed_from_attempt_public_id: null,
            claimed_at: OBSERVED_AT,
            seal_id: null,
            terminal_status: null,
            reason_code: null,
            event_count: null,
            final_run_seq: null,
            final_attempt_seq: null,
            final_event_digest: null,
            event_stream_digest: null,
            sealed_at: null,
          },
        ],
      },
    ]);
    useTx(tx);
    const attempts = await createPostgresRunStore().listRunAttempts(UUID_RUN);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, seal: null });
  });

  it("readAttemptState folds the durable log", async () => {
    const prepared = prepareAttemptEvent(toolEvent(1));
    const { tx } = makeRoutingTx([
      { match: ATTEMPT_STATE, rows: [durableRow(prepared, "event-1", "5")] },
    ]);
    useTx(tx);
    const state = await createPostgresRunStore().readAttemptState(UUID_ATTEMPT);
    expect(state).toMatchObject({
      eventCount: 1,
      lastAttemptSeq: 1,
      lastRunSeq: "5",
      finalEventDigest: prepared.eventDigest,
    });
  });

  it("readAttemptEventsSince maps every returned event", async () => {
    const { tx } = makeRoutingTx([
      {
        match: READ_EVENTS,
        rows: [
          {
            id: "event-1",
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: ATTEMPT_PUBLIC_ID,
            run_seq: "5",
            attempt_seq: 1,
            event_schema_version: EVENT_SCHEMA_VERSION,
            event_type: "tool.call_completed",
            stage: "tool",
            payload_digest: SHA_1,
            event_digest: SHA_2,
            payload_inline: {},
            encrypted_payload_ref: null,
            observed_at: OBSERVED_AT,
            created_at: OBSERVED_AT,
          },
        ],
      },
    ]);
    useTx(tx);
    const events = await createPostgresRunStore().readAttemptEventsSince(
      UUID_RUN,
      "0",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.runSeq).toBe("5");
  });

  it("getFinalizationHandle returns a sealed attempt's grant", async () => {
    const { tx } = makeRoutingTx([
      {
        match: ATTEMPT_IDENTITY,
        rows: [
          {
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: ATTEMPT_PUBLIC_ID,
            run_id: UUID_RUN,
          },
        ],
      },
      {
        match: SELECT_HANDLE,
        rows: [
          {
            seal_id: "seal-1",
            terminal_status: "completed",
            event_count: 1,
            final_event_digest: SHA_2,
            event_stream_digest: SHA_3,
            grant_id: "grant-1",
            grant_public_id: "afg_abc",
            obligation_id: "obligation-1",
            submission_id: "afg_abc",
          },
        ],
      },
    ]);
    useTx(tx);
    const handle =
      await createPostgresRunStore().getFinalizationHandle(UUID_ATTEMPT);
    expect(handle).toMatchObject({
      runId: UUID_RUN,
      attemptPublicId: ATTEMPT_PUBLIC_ID,
      submissionId: "afg_abc",
      alreadySealed: true,
    });
  });

  it("getFinalizationHandle returns null for an unknown attempt", async () => {
    const { tx } = makeRoutingTx([]);
    useTx(tx);
    expect(
      await createPostgresRunStore().getFinalizationHandle(UUID_ATTEMPT),
    ).toBeNull();
  });

  it("getFinalizationHandle returns null while the attempt is unsealed", async () => {
    const { tx } = makeRoutingTx([
      {
        match: ATTEMPT_IDENTITY,
        rows: [
          {
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: ATTEMPT_PUBLIC_ID,
            run_id: UUID_RUN,
          },
        ],
      },
    ]);
    useTx(tx);
    expect(
      await createPostgresRunStore().getFinalizationHandle(UUID_ATTEMPT),
    ).toBeNull();
  });
});
