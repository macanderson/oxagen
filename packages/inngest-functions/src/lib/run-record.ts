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
  deferredAttester,
  type FrameRead,
  ledgerFrame,
  listSubagentChains,
  listSubagentSessions,
  readTranscriptFrames,
  type RunFrame,
  type RunStore,
  subagentChainRead,
  tachoFrame,
  TRANSCRIPT_FRAME_CAP,
} from "@oxagen/run-ledger";
import { evidenceStore } from "@oxagen/run-ledger/evidence-store";
import {
  digestBytes,
  type JsonValue,
  readArchiveSegment,
  type RunExportAttemptChain,
  type UnflattenReading,
  unflattenEventReading,
  wrappedFrameOf,
} from "@oxagen/tacho";
import {
  selectTachoEventRecords,
  selectTachoEvents,
  selectTachoSubagentEvents,
  type TachoEventRecord,
  type TachoFrameRow,
} from "@oxagen/telemetry";
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
  /** The tier the seal recorded and graded under (spec §8.4). */
  enforcementTier: string;
  completenessGaps: string[];
  replayGrade: string | null;
  /** One JCS envelope per frame, in sequence order. */
  envelopes: JsonValue[];
  /** The frames' own digests, in the same order, for the Merkle root. */
  digests: string[];
  /**
   * The attestation the seal signed when it was written (ADR-195): the key
   * id and the signature. Null for a wrapped session, whose seal is not a
   * ledger row, and for a ledger seal written with no attester key or before
   * the seal signed.
   */
  sealAttestation: { keyId: string; sig: string } | null;
  /**
   * Set on a wrapped run's subagent chain: where the chain sits in the run.
   * Absent on the run's own chain and on every ledger attempt.
   */
  chain?: RunExportAttemptChain;
}

type RunRecord =
  | { source: "ledger"; runId: string; attempts: AttemptRecord[] }
  | {
      source: "tacho";
      sessionUuid: string;
      enforcementTier: string;
      completenessGaps: string[];
      replayGrade: string | null;
      /** The chain's next free seq, which ingest moves before ClickHouse. */
      seqCount: number;
      /** The hash the seal recorded, or null while the session is open. */
      finalHash: string | null;
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
  //
  // The idle close and the abandon sweep seal through this store, so it
  // carries the attester: a seal signs its figures when it is written
  // (ADR-195), and a deployment with no key seals unsigned.
  const store = evidenceStore();
  return createPostgresRunStore({
    archive: store,
    bodies: store,
    attester: deferredAttester,
  });
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
            seqCount: schema.tachoSessions.seqCount,
            finalHash: schema.tachoSessions.finalHash,
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
        seqCount: row.seqCount,
        finalHash: row.finalHash,
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

/**
 * The `tacho_events` rows of a session, one read at a time, in sequence
 * order. Nothing is read until the caller asks for the next page, so a
 * caller that stops early reads no more.
 *
 * Each page is bounded above, as `readFrames` in the handlers' run-read.ts is.
 * `tacho_events` is read with `FINAL`, and a read with no upper bound scans
 * the chain from `afterSeq` to its end whatever the limit says. Unbounded, a
 * long session cost one scan of the rest of the chain per page (#4202).
 *
 * A chain numbers its frames without holes, so a full window of `PAGE` seqs
 * holds `PAGE` rows. A short window means the chain ended or it has a
 * recorded break. One read past the window tells the two apart.
 * The fallback read is bounded by the recorded head, so frames appended
 * during the read belong to the next enrichment job.
 */
async function* tachoRowPages(
  sessionUuid: string,
  snapshotHead: number,
): AsyncGenerator<TachoFrameRow[]> {
  let after = -1;
  while (after < snapshotHead) {
    const through = Math.min(after + PAGE, snapshotHead);
    const page = await selectTachoEvents({
      sessionUuid,
      afterSeq: after,
      throughSeq: through,
      limit: PAGE,
    });
    if (page.length > 0) yield page;
    if (page.length === PAGE) {
      after = through;
      continue;
    }
    const rest = await selectTachoEvents({
      sessionUuid,
      afterSeq: through,
      throughSeq: snapshotHead,
      limit: PAGE,
    });
    if (rest.length > 0) yield rest;
    const last = rest.at(-1);
    if (!last || rest.length < PAGE) return;
    after = last.seq;
  }
}

/** Every stored event of a session with its envelope columns, in order. */
async function allTachoRecords(
  sessionUuid: string,
): Promise<TachoEventRecord[]> {
  const records: TachoEventRecord[] = [];
  let after = -1;
  for (;;) {
    const page = await selectTachoEventRecords({
      sessionUuid,
      afterSeq: after,
      limit: PAGE,
    });
    records.push(...page);
    const last = page.at(-1);
    if (!last || page.length < PAGE) return records;
    after = last.frame.seq;
  }
}

/**
 * A wrapped frame as the export writes it. When the stored row rebuilds the
 * sealed event, proven by its hash (`unflattenEventReading`), the frame is
 * `wrappedFrameOf` that event and carries it, so a verifier recomputes the
 * hash (#3733). Otherwise it is the row's projection with no event, and the
 * verifier prints the frame's digest as not carried.
 *
 * `first` is the reading that rebuilt an earlier row of the session. The
 * rows of one session mostly share a reading, so trying it first saves the
 * search on most rows (#3814). The answer carries the reading this row
 * matched, or null when none did.
 */
function tachoExportFrame(
  record: TachoEventRecord,
  first: UnflattenReading | null,
): { frame: JsonValue; reading: UnflattenReading | null } {
  const { event, reading } = unflattenEventReading(record.envelope, {
    first,
  });
  if (event !== null) {
    const bytesRef =
      record.frame.bytesRef === "" ? null : record.frame.bytesRef;
    return {
      frame: wrappedFrameOf(
        event as unknown as Record<string, JsonValue>,
        bytesRef,
      ),
      reading,
    };
  }
  return { frame: tachoEnvelope(record.frame), reading: null };
}

/**
 * Every row of a session as the export writes it, in order. The last reading
 * that rebuilt a row is tried first on the next one. A row that no reading
 * rebuilds leaves the carried reading as it was.
 */
function tachoExportFrames(records: readonly TachoEventRecord[]): JsonValue[] {
  const frames: JsonValue[] = [];
  let reading: UnflattenReading | null = null;
  for (const record of records) {
    const built = tachoExportFrame(record, reading);
    frames.push(built.frame);
    if (built.reading !== null) reading = built.reading;
  }
  return frames;
}

/** A wrapped frame's projection from its row, without the event. */
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
 * Refuses a chain whose recorded head ClickHouse cannot return yet. Ingest
 * moves `seq_count` before the batch's insert is readable, so a read right
 * after a seal can return a prefix of the chain, or nothing. Signing that
 * prefix would leave the later frames out of an export that claims to hold
 * the whole chain. The error is a plain `Error`, so the export job retries
 * the read, and marks the export failed with this message once its retries
 * run out.
 *
 * The head is the highest seq read, not the last row's, so a chain with a
 * recorded break below its head still passes. A sealed chain also needs its
 * seal's frame among the rows. A host's seal holds against later frames, so
 * that frame is not always the last one.
 */
function assertHeadReadable(
  sessionUuid: string,
  records: readonly TachoEventRecord[],
  row: { seqCount: number; finalHash: string | null },
): void {
  if (row.seqCount === 0) return;
  const recorded = row.seqCount - 1;
  const head = records.reduce(
    (highest, record) => Math.max(highest, record.frame.seq),
    -1,
  );
  if (head < recorded) {
    throw new Error(
      `chain ${sessionUuid} records seq ${recorded} as its head, and the event store returns ${head < 0 ? "no frame" : `frames through seq ${head}`}`,
    );
  }
  if (
    row.finalHash !== null &&
    !records.some((record) => record.frame.hash === row.finalHash)
  ) {
    throw new Error(
      `chain ${sessionUuid} sealed at ${row.finalHash}, and the event store returns no frame with that hash`,
    );
  }
}

/** A wrapped chain's segment, built from its stored rows. */
function tachoSegment(
  sessionUuid: string,
  records: readonly TachoEventRecord[],
  seal: {
    enforcementTier: string;
    completenessGaps: string[];
    replayGrade: string | null;
  },
): SealedSegment {
  return {
    attemptId: sessionUuid,
    attemptPublicId: sessionUuid,
    frameCount: records.length,
    merkleRoot: "",
    archiveSegmentDigest: null,
    eventStreamDigest: null,
    enforcementTier: seal.enforcementTier,
    completenessGaps: seal.completenessGaps,
    replayGrade: seal.replayGrade,
    envelopes: tachoExportFrames(records),
    digests: records.map((r) => r.frame.hash),
    // A wrapped chain's seal is not a ledger row, so it carries no signed
    // attestation (ADR-195).
    sealAttestation: null,
  };
}

/**
 * The sealed segments of a run: one per sealed ledger attempt, read from the
 * attempt's archive segment. A wrapped run has one for its own chain, built
 * from its rows, and one more per subagent chain (#3823): a subagent records
 * on a hash chain of its own, from genesis at its own seq 0, so each chain is
 * attested and verified as an attempt of its own, with the chain's session
 * uuid as its id and its tier, gaps and grade from the chain's own row. A
 * chain that recorded no frame has nothing to attest and is left out. Every
 * other chain is read through the head its row records
 * (`assertHeadReadable`). A child that never sealed, such as a crashed
 * subagent, is signed at that head rather than held until its idle close. A
 * ledger attempt sealed before the recorder (no segment) fails the read: an
 * export attests what the seal committed to, and that seal committed to
 * nothing.
 */
export async function readSealedSegments(
  scope: RunScope,
  record: RunRecord,
): Promise<SealedSegment[]> {
  return runInTenantScope(scope, async () => {
    if (record.source === "tacho") {
      const own = await allTachoRecords(record.sessionUuid);
      assertHeadReadable(record.sessionUuid, own, record);
      const segments = [tachoSegment(record.sessionUuid, own, record)];
      const chains = await listSubagentChains(scope, record.sessionUuid);
      for (const chain of chains) {
        if (chain.seqCount === 0) continue;
        const records = await allTachoRecords(chain.sessionUuid);
        assertHeadReadable(chain.sessionUuid, records, chain);
        segments.push({
          ...tachoSegment(chain.sessionUuid, records, {
            enforcementTier: chain.enforcementTier,
            completenessGaps: gapsOf(chain.completenessGaps),
            replayGrade: chain.replayGrade,
          }),
          chain: {
            session_uuid: chain.sessionUuid,
            parent_session_uuid: chain.parentSessionUuid,
            subagent_id: chain.subagentId,
            subagent_type: chain.subagentType,
            spawn_tool_use_id: chain.spawnToolUseId,
          },
        });
      }
      return segments;
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
        // The tier the seal graded under, so the export signs what the seal
        // signed. A seal written before the column existed was graded as
        // `harness`, which is how every reader takes a null.
        enforcementTier: seal.enforcementTier ?? "harness",
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
        sealAttestation:
          seal.attestationKeyId !== null && seal.attestationSig !== null
            ? { keyId: seal.attestationKeyId, sig: seal.attestationSig }
            : null,
      });
    }
    return segments;
  });
}

/**
 * The run's own chain as the projection reads it, a page at a time: a
 * wrapped session's `tacho_events` rows, or a ledger run's events. The
 * caller runs it inside the run's tenant scope.
 */
async function* ownFramePages(record: RunRecord): AsyncGenerator<RunFrame[]> {
  if (record.source === "tacho") {
    for await (const rows of tachoRowPages(
      record.sessionUuid,
      record.seqCount - 1,
    ))
      yield rows.map(tachoFrame);
    return;
  }
  const store = ledgerStore();
  let after = "0";
  for (;;) {
    const page = await store.readAttemptEventsSince(record.runId, after, PAGE);
    if (page.length > 0) yield page.map(ledgerFrame);
    const last = page.at(-1);
    if (!last || page.length < PAGE) return;
    after = last.runSeq;
  }
}

/**
 * The run's own chain up to `upTo` frames and past it by at most a page:
 * a wrapped session's `tacho_events` rows, or a ledger run's events. Pages
 * are read only while the read is short of `upTo`, so a long run costs at
 * most one page past the cap (#3784).
 */
async function ownFrames(
  record: RunRecord,
  upTo: number,
): Promise<RunFrame[]> {
  const frames: RunFrame[] = [];
  for await (const page of ownFramePages(record)) {
    frames.push(...page);
    if (frames.length > upTo) return frames;
  }
  return frames;
}

/**
 * The frames the Run page folds for this run, read the same way
 * (`readTranscriptFrames` in `@oxagen/run-ledger`): every subagent chain
 * spliced in where it was spawned, late harness reports uncounted, each model
 * call once, to `TRANSCRIPT_FRAME_CAP` frames. The enrichment job behind
 * `summarize_run` (`run.enrich`) reads these, so the account it writes covers
 * a subagent's work as the page draws it (#3823).
 *
 * The read holds up to `TRANSCRIPT_FRAME_CAP` frames across every chain, not
 * one page (#3784). Splicing a subagent chain in where it was spawned needs
 * the frame that spawned it, which can sit on any page of the run's own
 * chain. The frames carry summaries and body references only. The enrichment
 * job opens bodies later, up to its text and body-read ceilings.
 */
export async function readTranscriptFramesOf(
  scope: RunScope,
  record: RunRecord,
): Promise<FrameRead> {
  return runInTenantScope(scope, () =>
    readTranscriptFrames(
      {
        own: async (cap) => {
          const frames = await ownFrames(record, cap);
          return frames.length > cap
            ? { frames: frames.slice(0, cap), complete: false }
            : { frames, complete: true };
        },
        subagents:
          record.source === "tacho"
            ? subagentChainRead(
                selectTachoSubagentEvents,
                record.sessionUuid,
                (root) => listSubagentSessions(scope, root),
              )
            : null,
      },
      TRANSCRIPT_FRAME_CAP,
    ),
  );
}
