// run-record.ts — a run's record as the durable jobs read it (ADR-058): the
// seal figures and the frames, from the store that recorded the run, inside
// the run's tenant scope.
//
// `arun_…` is an evidence-ledger run: attempts and seals from
// `@oxagen/run-ledger`, frame envelopes from each seal's archive segment (the
// same bytes the seal wrote, spec §13.3). `tse_…` is a wrapped session:
// `tacho.sessions` and the hash-chained rows in ClickHouse `tacho_events`.
import { schema, withTenantDb } from "@oxagen/database";
import {
  type AttemptRecord,
  createPostgresRunStore,
  ledgerFrame,
  type RunFrame,
  type RunStore,
  tachoFrame,
} from "@oxagen/run-ledger";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import { digestBytes, type JsonValue, readArchiveSegment } from "@oxagen/tacho";
import { selectTachoEvents, type TachoFrameRow } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq } from "drizzle-orm";

export interface RunScope {
  orgId: string;
  workspaceId: string;
}

/** The seal figures one attestation signs (spec §8.3), per sealed attempt. */
export interface SealedSegment {
  attemptId: string;
  attemptPublicId: string;
  frameCount: number;
  merkleRoot: string;
  /** sha256 over the segment bytes as stored; a wrapped session has none. */
  archiveSegmentDigest: string | null;
  /** The seal's `event_stream_digest`; a wrapped session has none. */
  eventStreamDigest: string | null;
  enforcementTier: string;
  completenessGaps: string[];
  replayGrade: string | null;
  /** One JCS envelope per frame, in sequence order. */
  envelopes: JsonValue[];
  /** The frames' own digests, in the same order, for the Merkle root. */
  digests: string[];
}

type RunRecord =
  | { source: "ledger"; runId: string; attempts: AttemptRecord[] }
  | {
      source: "tacho";
      sessionUuid: string;
      enforcementTier: string;
      completenessGaps: string[];
      replayGrade: string | null;
    };

const gapsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

export function ledgerStore(): RunStore {
  // `evidenceStore()` is both seams already (`EvidenceStore extends
  // RunBodyStore, RunArchiveStore`). Passing it as the archive alone left a
  // store that refuses any append whose frame carries a retained body, which
  // is a trap for the next producer rather than a decision anyone made.
  const store = evidenceStore();
  return createPostgresRunStore({ archive: store, bodies: store });
}

/** The run behind a public id in its tenant, or null. */
export async function resolveRunRecord(
  scope: RunScope,
  runPublicId: string,
): Promise<RunRecord | null> {
  return runInTenantScope(scope, async () => {
    if (runPublicId.startsWith("tse_")) {
      const [row] = await withTenantDb((tx) =>
        tx
          .select({
            sessionUuid: schema.tachoSessions.sessionUuid,
            enforcementTier: schema.tachoSessions.enforcementTier,
            completenessGaps: schema.tachoSessions.completenessGaps,
            replayGrade: schema.tachoSessions.replayGrade,
          })
          .from(schema.tachoSessions)
          .where(
            and(
              eq(schema.tachoSessions.publicId, runPublicId),
              eq(schema.tachoSessions.orgId, scope.orgId),
              eq(schema.tachoSessions.workspaceId, scope.workspaceId),
            ),
          )
          .limit(1),
      );
      if (!row) return null;
      return {
        source: "tacho",
        sessionUuid: row.sessionUuid,
        enforcementTier: row.enforcementTier,
        completenessGaps: gapsOf(row.completenessGaps),
        replayGrade: row.replayGrade,
      };
    }
    const store = ledgerStore();
    const summary = await store.getRunByPublicId(runPublicId);
    if (!summary) return null;
    return {
      source: "ledger",
      runId: summary.runId,
      attempts: await store.listRunAttempts(summary.runId),
    };
  });
}

const PAGE = 500;

/** Every `tacho_events` row of a session, in sequence order. */
async function allTachoRows(sessionUuid: string): Promise<TachoFrameRow[]> {
  const rows: TachoFrameRow[] = [];
  let after = -1;
  for (;;) {
    const page = await selectTachoEvents({
      sessionUuid,
      afterSeq: after,
      limit: PAGE,
    });
    rows.push(...page);
    const last = page.at(-1);
    if (!last || page.length < PAGE) return rows;
    after = last.seq;
  }
}

/** A wrapped frame as the export writes it: the row's chained facts. */
function tachoEnvelope(row: TachoFrameRow): JsonValue {
  return {
    event_id: row.eventId,
    seq: row.seq,
    ts: row.ts,
    kind: row.kind,
    prev_hash: row.prevHash,
    hash: row.hash,
    content: {
      digest: row.contentDigest === "" ? null : row.contentDigest,
      bytes_ref: row.bytesRef === "" ? null : row.bytesRef,
      redactions:
        row.redactions === "" ? [] : (JSON.parse(row.redactions) as JsonValue),
    },
    body: row.body === "" ? null : (JSON.parse(row.body) as JsonValue),
    tool_name: row.toolName,
    tool_status: row.toolStatus,
    tool_use_id: row.toolUseId,
    model: row.model,
    provider: row.provider,
    policy_decision: row.policyDecision,
    cost_usd_micros: row.costUsdMicros,
    turn_seq: row.turnSeq,
  };
}

/**
 * The sealed segments of a run: one per sealed ledger attempt, read from the
 * attempt's archive segment; one for a wrapped session, built from its rows.
 * A ledger attempt sealed before the recorder (no segment) fails the read:
 * an export attests what the seal committed to, and that seal committed to
 * nothing.
 */
export async function readSealedSegments(
  scope: RunScope,
  record: RunRecord,
): Promise<SealedSegment[]> {
  return runInTenantScope(scope, async () => {
    if (record.source === "tacho") {
      const rows = await allTachoRows(record.sessionUuid);
      return [
        {
          attemptId: record.sessionUuid,
          attemptPublicId: record.sessionUuid,
          frameCount: rows.length,
          merkleRoot: "",
          archiveSegmentDigest: null,
          eventStreamDigest: null,
          enforcementTier: record.enforcementTier,
          completenessGaps: record.completenessGaps,
          replayGrade: record.replayGrade,
          envelopes: rows.map(tachoEnvelope),
          digests: rows.map((row) => row.hash),
        },
      ];
    }
    const store = evidenceStore();
    const segments: SealedSegment[] = [];
    const sealed = record.attempts
      .filter((attempt) => attempt.seal !== null)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
    for (const attempt of sealed) {
      const seal = attempt.seal as NonNullable<AttemptRecord["seal"]>;
      if (seal.archiveSegmentRef === null || seal.merkleRoot === null) {
        throw new Error(
          `attempt ${attempt.attemptPublicId} sealed before the recorder graded it: no archive segment to export`,
        );
      }
      const bytes = await store.getSegment(seal.archiveSegmentRef);
      const envelopes = readArchiveSegment(bytes);
      segments.push({
        attemptId: attempt.attemptId,
        attemptPublicId: attempt.attemptPublicId,
        frameCount: envelopes.length,
        merkleRoot: seal.merkleRoot,
        archiveSegmentDigest: digestBytes(bytes),
        eventStreamDigest: seal.eventStreamDigest,
        enforcementTier: "harness",
        completenessGaps: seal.completenessGaps,
        replayGrade: seal.replayGrade,
        envelopes,
        digests: envelopes.map((envelope) => {
          const digest = (envelope as { event_digest?: unknown }).event_digest;
          if (typeof digest !== "string") {
            throw new Error(
              `archive segment ${seal.archiveSegmentRef} holds a frame with no event_digest`,
            );
          }
          return digest;
        }),
      });
    }
    return segments;
  });
}

/** Every frame of the run as the projection reads it, in sequence order. */
export async function readRunFrames(
  scope: RunScope,
  record: RunRecord,
): Promise<RunFrame[]> {
  return runInTenantScope(scope, async () => {
    if (record.source === "tacho") {
      return (await allTachoRows(record.sessionUuid)).map(tachoFrame);
    }
    const store = ledgerStore();
    const frames: RunFrame[] = [];
    let after = "0";
    for (;;) {
      const page = await store.readAttemptEventsSince(
        record.runId,
        after,
        PAGE,
      );
      frames.push(...page.map(ledgerFrame));
      const last = page.at(-1);
      if (!last || page.length < PAGE) return frames;
      after = last.runSeq;
    }
  });
}
