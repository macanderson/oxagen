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
  isContentBearingFrame,
  isReplayGrade,
} from "@oxagen/tacho";
import { and, asc, eq } from "drizzle-orm";
import { publishedGaps, publishedTier, runScope, type RunScope } from "./run.list";
import {
  defaultRunReadDeps,
  readAllFrames,
  resolveRun,
  type ResolvedRun,
  type RunReadDeps,
} from "./lib/run-read";

const checkpoints = schema.tachoCheckpoints;

/** The signed checkpoints of one wrapped session, in sequence. */
export function tachoCheckpointQuery(
  db: Pick<Tx, "select">,
  scope: RunScope,
  sessionUuid: string,
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
        eq(checkpoints.sessionId, sessionUuid),
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
  checkpoints: (
    scope: RunScope,
    sessionUuid: string,
  ) => Promise<CheckpointRow[]>;
};

export const postgresChainCheckpoints = async (
  scope: RunScope,
  sessionUuid: string,
): Promise<CheckpointRow[]> =>
  withTenantDb((tx) => tachoCheckpointQuery(tx, scope, sessionUuid));

// ---- Gaps -----------------------------------------------------------------------------

export interface SequenceGap {
  from: string;
  to: string;
}

/**
 * The sequences missing between the first and the last frame read. Only the
 * interior is reported: a recording that starts at 7 is not missing 1 to 6,
 * because nothing says the run began at 1.
 *
 * The ledger refuses a sequence gap at append, so a ledger run answers none;
 * a wrapped session's producer can drop events, and this is where that shows.
 */
export function sequenceGaps(frames: readonly RunFrame[]): {
  gaps: SequenceGap[];
  missing: number;
} {
  const gaps: SequenceGap[] = [];
  let missing = 0;
  for (let i = 1; i < frames.length; i += 1) {
    const prev = BigInt((frames[i - 1] as RunFrame).seq);
    const next = BigInt((frames[i] as RunFrame).seq);
    if (next <= prev + 1n) continue;
    gaps.push({ from: String(prev + 1n), to: String(next - 1n) });
    missing += Number(next - prev - 1n);
  }
  return { gaps, missing };
}

/**
 * Frames that carried content and whose bytes were not retained — the same
 * rule the seal derives `body_missing` from (`deriveCompletenessGaps`): a
 * content-bearing frame with no body reference, or any frame whose digest was
 * recorded and whose bytes were not.
 */
export function missingBodies(frames: readonly RunFrame[]): number {
  return frames.filter(
    (frame) =>
      (isContentBearingFrame(frame.type) || frame.body.bodyDigest !== null) &&
      frame.body.bodyRef === null,
  ).length;
}

/** Bodies the recording retained: what `view` needs at least one of. */
function retainedBodies(frames: readonly RunFrame[]): number {
  return frames.filter((frame) => frame.body.bodyRef !== null).length;
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

/**
 * The seal, as each store records it. A wrapped session has no seal row of its
 * own: the sealed columns on the session are its seal, and the chain head of
 * its last checkpoint is the commitment it carries in place of a Merkle root.
 */
function sealOf(
  run: ResolvedRun,
  lastCheckpoint: CheckpointRow | undefined,
): RunChainGetOutput["seal"] {
  if (run.source === "ledger") {
    const seal = run.record.seal;
    if (!seal) return null;
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
    };
  }
  const { session } = run.row;
  if (session.sealedAt === null) return null;
  return {
    sealedAt: session.sealedAt.toISOString(),
    terminalStatus: session.outcome,
    eventCount: session.seqCount,
    finalRunSeq: session.seqCount > 0 ? String(session.seqCount) : null,
    finalEventDigest: lastCheckpoint?.chainHead ?? null,
    eventStreamDigest: lastCheckpoint?.chainHead ?? null,
    merkleRoot: lastCheckpoint?.chainHead ?? null,
    archiveSegmentRef: null,
  };
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
        ? await deps.checkpoints(scope, run.sessionUuid)
        : [];

    const sequences = sequenceGaps(read.frames);
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

    const recordedGrade =
      run.source === "ledger"
        ? run.record.seal?.replayGrade
        : run.row.session.replayGrade;
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
      merkleRoot:
        run.source === "ledger"
          ? (run.record.seal?.merkleRoot ?? null)
          : (rows.at(-1)?.chainHead ?? null),
      checkpoints: rows.map(toCheckpoint),
      gaps: {
        missingSequences: sequences.gaps,
        missingFrameCount: sequences.missing,
        missingBodies: missingBodies(read.frames),
        recorded,
      },
      seal: sealOf(run, rows.at(-1)),
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
});
