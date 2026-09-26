// `get_run_chain`: what makes one run's record tamper-evident, and what it is
// missing (Mission Control spec §8.3, §8.4; the Run page's Chain-and-seal tab).
//
// Everything it answers is already recorded somewhere, and this handler is the
// one place that reads all of it together:
//
//   - the hash rule and the sequence gaps, from the frames (lib/run-read.ts);
//   - the signed checkpoints, from `tacho.checkpoints` for a wrapped session —
//     a ledger attempt commits at its seal and checkpoints nothing in between,
//     so it answers none;
//   - the Merkle root, the seal and the recorded grade, from the ledger's
//     latest attempt seal or the wrapped session's sealed columns;
//   - the ladder, from `explainReplayGrade` (@oxagen/tacho), the same function
//     the seal graded with and `fork_run` gates on.
//
// The ladder is computed from what this read can see, and the recorded grade is
// read from the seal and never recomputed (§8.4: nothing raises a grade after
// the seal). A caller renders the recorded word; the ladder says why.
//
// The walk is bounded (`CHAIN_FRAME_CAP`) and says so: gaps found in a prefix
// are the prefix's, and `complete: false` is what stops a caller presenting
// them as the run's.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  CHAIN_FRAME_CAP,
  type ChainCheckpoint,
  runChainGet,
  type RunChainGetOutput,
} from "@oxagen/oxagen/contracts/run.chain.get";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import type { RunFrame } from "@oxagen/run-ledger";
import {
  explainReplayGrade,
  frameOwesBody,
  isReplayGrade,
  RUN_ATTESTATION_FIELDS,
} from "@oxagen/tacho";
import { TACHO_EVENTS_RETENTION_MONTHS } from "@oxagen/telemetry";
import { and, asc, eq } from "drizzle-orm";
import {
  ledgerAllSealsQuery,
  publishedGaps,
  publishedTier,
  runScope,
  type LedgerSeal,
  type RunScope,
} from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
} from "./lib/run-read";

const checkpoints = schema.tachoCheckpoints;

/**
 * The signed checkpoints of one wrapped session, in sequence.
 * `sessionId` is `tacho.sessions.id` (the row UUID), matching how ingest and
 * `tacho.session.get` write and read the foreign key. Passing the external
 * `session_uuid` here returns an empty list for every normal wrapped run.
 */
export function tachoCheckpointQuery(
  db: Pick<Tx, "select">,
  scope: RunScope,
  sessionId: string,
) {
  return db
    .select({
      seq: checkpoints.seq,
      chainHead: checkpoints.chainHead,
      eventCount: checkpoints.eventCount,
      signedAt: checkpoints.signedAt,
      deviceKeyFingerprint: checkpoints.deviceKeyFingerprint,
      platformKeyId: checkpoints.platformKeyId,
      countersignedAt: checkpoints.countersignedAt,
      anchorRoot: checkpoints.anchorRoot,
      anchoredAt: checkpoints.anchoredAt,
    })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.orgId, scope.orgId),
        eq(checkpoints.workspaceId, scope.workspaceId),
        eq(checkpoints.sessionId, sessionId),
      ),
    )
    .orderBy(asc(checkpoints.seq));
}

export type CheckpointRow = {
  seq: number;
  chainHead: string;
  eventCount: number;
  signedAt: Date;
  deviceKeyFingerprint: string;
  platformKeyId: string | null;
  countersignedAt: Date | null;
  anchorRoot: string | null;
  anchoredAt: Date | null;
};

export type RunChainGetDeps = RunReadDeps & {
  checkpoints: (scope: RunScope, sessionId: string) => Promise<CheckpointRow[]>;
  /**
   * Every attempt seal of a ledger run, oldest first — not only the latest,
   * which `readAllFrames` already walks past (finding 8,
   * macanderson/oxagen#3370): a retried run's frame count and gaps span
   * every attempt, so the seals shown beside them must too.
   */
  ledgerSeals: (scope: RunScope, runId: string) => Promise<LedgerSeal[]>;
  /** The clock the retention boundary is measured on; the system's by default. */
  now?: () => Date;
};

export const postgresChainCheckpoints = async (
  scope: RunScope,
  sessionId: string,
): Promise<CheckpointRow[]> =>
  withTenantDb((tx) => tachoCheckpointQuery(tx, scope, sessionId));

export const postgresChainLedgerSeals = async (
  scope: RunScope,
  runId: string,
): Promise<LedgerSeal[]> =>
  withTenantDb((tx) => ledgerAllSealsQuery(tx, scope, runId));

// ---- Gaps -----------------------------------------------------------------------------

export interface SequenceGap {
  from: string;
  to: string;
}

/**
 * The sequences missing from a frame walk, against the recorded bounds when
 * the caller knows them.
 *
 * Without bounds, only the interior is reported: a recording that starts at 7
 * is not missing 1 to 6, because nothing says the run began at 1. With bounds
 * (a wrapped session's `seqCount` proves 0..seqCount-1; a ledger seal names
 * its final sequence), a walk that lost the first or last frames reports those
 * gaps too, so the Chain tab cannot claim a denser ladder than the record.
 */
export function sequenceGaps(
  frames: readonly RunFrame[],
  bounds?: { start?: string | null; end?: string | null },
): {
  gaps: SequenceGap[];
  missing: number;
} {
  const gaps: SequenceGap[] = [];
  let missing = 0;
  const add = (from: bigint, to: bigint) => {
    if (to < from) return;
    gaps.push({ from: String(from), to: String(to) });
    missing += Number(to - from + 1n);
  };

  if (frames.length === 0) {
    if (
      bounds?.start != null &&
      bounds.start !== "" &&
      bounds?.end != null &&
      bounds.end !== ""
    ) {
      add(BigInt(bounds.start), BigInt(bounds.end));
    }
    return { gaps, missing };
  }

  const first = BigInt((frames[0] as RunFrame).seq);
  const last = BigInt((frames[frames.length - 1] as RunFrame).seq);
  if (bounds?.start != null && bounds.start !== "") {
    const start = BigInt(bounds.start);
    if (first > start) add(start, first - 1n);
  }
  for (let i = 1; i < frames.length; i += 1) {
    const prev = BigInt((frames[i - 1] as RunFrame).seq);
    const next = BigInt((frames[i] as RunFrame).seq);
    if (next <= prev + 1n) continue;
    add(prev + 1n, next - 1n);
  }
  if (bounds?.end != null && bounds.end !== "") {
    const end = BigInt(bounds.end);
    if (last < end) add(last + 1n, end);
  }
  return { gaps, missing };
}

/**
 * Frames that owe a body and whose bytes were not all retained, under the
 * rule both seals derive `body_missing` from (`frameOwesBody`,
 * `bodyIsPartial`): a content-bearing frame with no body reference, any frame
 * whose digest was recorded and whose bytes were not, or a model call whose
 * body holds one half of the exchange. A wrapped session's later sighting of
 * a model call owes nothing, because the frame sealed first holds the call's
 * content.
 */
export function missingBodies(frames: readonly RunFrame[]): number {
  return frames.filter(
    (frame) =>
      frameOwesBody({
        type: frame.type,
        digest: frame.body.bodyDigest,
        laterSighting: (frame.llmCall?.duplicateOf ?? null) !== null,
      }) &&
      (frame.body.bodyRef === null || frame.llmCall?.partial === true),
  ).length;
}

/** Bodies the recording retained: what `view` needs at least one of. */
function retainedBodies(frames: readonly RunFrame[]): number {
  return frames.filter((frame) => frame.body.bodyRef !== null).length;
}

/**
 * Whether a wrapped session's earliest frames may have expired from
 * `tacho_events` (#4316). The table keeps a frame
 * `TACHO_EVENTS_RETENTION_MONTHS` after receipt (migration 0032), and a
 * wrapped session has no archive segment. A frame that expired is not a chain
 * break, so a session this old is not bounded from seq 0: the frames below the
 * first one read are not reported missing. The trade is that a frame really
 * lost at the head of such a session goes unreported too. Interior gaps and
 * the tail are still checked.
 *
 * `createdAt` is the session row's birth on the server's clock, the clock the
 * TTL counts from. Ingest writes the row in the same request that receives
 * the first frames, so the row is never younger than its first frame's
 * receipt, and the comparison needs no slack. The session's own `startedAt`
 * comes from the host's clock, and a host set back a year would make a fresh
 * session look expired.
 */
export function framesMayHaveExpired(createdAt: Date, now: Date): boolean {
  const boundary = new Date(now.getTime());
  boundary.setUTCMonth(boundary.getUTCMonth() - TACHO_EVENTS_RETENTION_MONTHS);
  return createdAt.getTime() < boundary.getTime();
}

// ---- The seal side --------------------------------------------------------------------

function toCheckpoint(row: CheckpointRow): ChainCheckpoint {
  return {
    seq: String(row.seq),
    chainHead: row.chainHead,
    eventCount: row.eventCount,
    signedAt: row.signedAt.toISOString(),
    deviceKeyFingerprint: row.deviceKeyFingerprint,
    platformKeyId: row.platformKeyId,
    countersignedAt: row.countersignedAt?.toISOString() ?? null,
    anchorRoot: row.anchorRoot,
    anchoredAt: row.anchoredAt?.toISOString() ?? null,
  };
}

/** One ledger attempt seal in the tab's wire shape. */
function toChainSeal(seal: LedgerSeal): RunChainGetOutput["seals"][number] {
  return {
    sealedAt: seal.sealedAt.toISOString(),
    // The attempt's terminal status, not the run's: a run can be `failed`
    // while the attempt under the seal was `abandoned`, and the tab is
    // reporting on the attempt.
    terminalStatus: seal.terminalStatus,
    eventCount: seal.eventCount,
    finalRunSeq: seal.finalRunSeq,
    finalEventDigest: seal.finalEventDigest,
    eventStreamDigest: seal.eventStreamDigest,
    merkleRoot: seal.merkleRoot,
    archiveSegmentRef: seal.archiveSegmentRef,
    archiveSegmentDigest: seal.archiveSegmentDigest,
    attestation: sealAttestation(seal),
  };
}

/**
 * The attestation the seal signed when it was written (ADR-195), or null
 * for a seal written with no attester key or before the seal signed. The
 * values it signs are this seal's own fields, so it names the fields and
 * carries no copy of them. A key id without its signature is not an
 * attestation, and the row's CHECK refuses one.
 */
function sealAttestation(
  seal: LedgerSeal,
): RunChainGetOutput["seals"][number]["attestation"] {
  if (seal.attestationKeyId === null || seal.attestationSig === null)
    return null;
  return {
    alg: "ed25519",
    keyId: seal.attestationKeyId,
    sig: seal.attestationSig,
    signsOver: [...RUN_ATTESTATION_FIELDS],
  };
}

/**
 * Every seal a run carries, oldest first. A ledger run can hold one per
 * attempt (a retry or a lease reclaim starts a new one), so this walks all of
 * them rather than the latest alone — matching `readAllFrames`, which already
 * reads every attempt's frames into `frameCount` and the gap analysis
 * (finding 8, macanderson/oxagen#3370). A wrapped session has no seal row of
 * its own: the sealed columns on the session are its one seal. Its commitment
 * is `final_hash`, the hash `terminalPatch` writes at `agent_stop` over the
 * *whole* session — not the last periodic checkpoint's chain head, which the
 * collector stops advancing once `session.sealed` is written and so can cover
 * only a prefix when frames arrived after it.
 */
function sealsOf(
  run: ResolvedRun,
  ledgerSeals: readonly LedgerSeal[],
): RunChainGetOutput["seals"] {
  if (run.source === "ledger") {
    return ledgerSeals.map(toChainSeal);
  }
  const { session } = run.row;
  if (session.sealedAt === null) return [];
  // Ingest stores `seq_count` as `last.seq + 1` (the next free sequence), so
  // the final recorded sequence is one less. A three-frame session ends at
  // seq 2 with `seq_count` 3; reporting 3 would name a frame that never ran.
  const finalRunSeq =
    session.seqCount > 0 ? String(session.seqCount - 1) : null;
  return [
    {
      sealedAt: session.sealedAt.toISOString(),
      terminalStatus: session.outcome,
      eventCount: session.seqCount,
      finalRunSeq,
      // final_hash is a hash-chain head (tacho.sha256_prev_hash_v1), not an
      // RFC 6962 Merkle root and not an event-stream digest. Advertising it
      // under those names makes the Chain tab, CLI and API claim commitments
      // nobody computed (Codex P1 on #3352). Leave them null until Tacho
      // persists the real values; finalEventDigest carries the chain head.
      finalEventDigest: session.finalHash,
      eventStreamDigest: null,
      merkleRoot: null,
      archiveSegmentRef: null,
      // A wrapped session has no seal row, so nothing signed its figures at
      // seal time. Its signed checkpoints are listed under `checkpoints`,
      // and `export_run` attests its frames when the bundle is built.
      archiveSegmentDigest: null,
      attestation: null,
    },
  ];
}

export function createRunChainGetHandler(
  deps: RunChainGetDeps,
): CapabilityHandler<typeof runChainGet> {
  return async (input, ctx): Promise<RunChainGetOutput> => {
    const scope = runScope(ctx);
    const run = await resolveRun(deps, ctx, input.runId);
    const read = await readAllFrames(deps, run, CHAIN_FRAME_CAP);
    const rows =
      run.source === "tacho"
        ? await deps.checkpoints(scope, run.row.session.id)
        : [];
    const ledgerSeals =
      run.source === "ledger" ? await deps.ledgerSeals(scope, run.runId) : [];

    const expectedEnd =
      run.source === "tacho"
        ? run.row.session.seqCount > 0
          ? String(run.row.session.seqCount - 1)
          : null
        : (ledgerSeals.at(-1)?.finalRunSeq ?? null);
    // The walk stops at CHAIN_FRAME_CAP. Naming the seal's final sequence as
    // the end bound would classify every unread frame past the cap as missing
    // and mark a valid long run as chain_break, even though complete: false
    // already says those frames were not read (finding 4052307524). Apply the
    // terminal bound only when the walk finished.
    //
    // A wrapped session starts at seq 0, unless its earliest frames may have
    // expired, in which case the frames below the first one read are gone,
    // not missing (#4316).
    // A reader that did not select `createdAt` bounds from seq 0, as every
    // read did before #4316.
    const bornAt =
      run.source === "tacho" ? run.row.session.createdAt : undefined;
    const startsAtZero =
      run.source === "tacho" &&
      (bornAt === undefined ||
        !framesMayHaveExpired(bornAt, deps.now?.() ?? new Date()));
    const sequences = sequenceGaps(read.frames, {
      start: startsAtZero ? "0" : null,
      end: read.complete ? expectedEnd : null,
    });
    const recorded =
      run.source === "ledger"
        ? publishedGaps(run.record.seal?.completenessGaps)
        : publishedGaps(run.row.session.completenessGaps);
    const enforcementTier =
      run.source === "ledger"
        ? publishedTier(run.record.seal?.enforcementTier)
        : publishedTier(run.row.session.enforcementTier);

    // The ladder is computed from what this read can see: the gaps the seal
    // recorded, plus a chain break the walk found that the seal did not name.
    const observed = new Set<string>(recorded);
    if (sequences.gaps.length > 0) observed.add("chain_break");
    if (missingBodies(read.frames) > 0 && !observed.has("digest_only")) {
      observed.add("body_missing");
    }
    const explained = explainReplayGrade({
      gaps: [...observed],
      enforcementTier,
      retainedBodies: retainedBodies(read.frames),
      harnessReproducible: false,
    });

    const recordedGradeRaw =
      run.source === "ledger"
        ? run.record.seal?.replayGrade
        : run.row.session.replayGrade;
    // A live run (including a retry after a sealed attempt) has no recorded
    // grade yet — `toLedgerRunItem` already nulls it on the row. Returning the
    // previous attempt's seal grade here would present a historical trust
    // grade as the current run's before the active attempt has sealed.
    const recordedGrade = run.item.status === "live" ? null : recordedGradeRaw;
    const first = read.frames.at(0);
    const last = read.frames.at(-1);

    return {
      runId: input.runId,
      hashRule:
        run.source === "ledger"
          ? "ledger.event_stream_digest_v1"
          : "tacho.sha256_prev_hash_v1",
      frameCount: read.frames.length,
      firstSeq: first?.seq ?? null,
      lastSeq: last?.seq ?? null,
      // The latest attempt's root: the one field that summarizes "the current
      // commitment" for a quick render. `seals` below carries every attempt's
      // root for a caller that needs the full audit trail.
      merkleRoot:
        run.source === "ledger"
          ? (ledgerSeals.at(-1)?.merkleRoot ?? null)
          : run.row.session.sealedAt !== null
            ? run.row.session.finalHash
            : (rows.at(-1)?.chainHead ?? null),
      checkpoints: rows.map(toCheckpoint),
      gaps: {
        missingSequences: sequences.gaps,
        missingFrameCount: sequences.missing,
        missingBodies: missingBodies(read.frames),
        recorded,
      },
      seals: sealsOf(run, ledgerSeals),
      enforcementTier,
      recordedGrade: isReplayGrade(recordedGrade) ? recordedGrade : null,
      ladder: explained.ladder,
      complete: read.complete,
    };
  };
}

export const runChainGetHandler = createRunChainGetHandler({
  ...defaultRunReadDeps(),
  checkpoints: postgresChainCheckpoints,
  ledgerSeals: postgresChainLedgerSeals,
});
