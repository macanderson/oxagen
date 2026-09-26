// run-read.ts — the frames of a run as its transcript reads them, composed
// once (ADR-182).
//
// Two readers fold a run's steps: `get_run_transcript`, which the Run page
// draws, and the `run.summarize` job, which writes the run's account from
// them. Each reaches the stores its own way, so each passes the reads it has.
// What the reads are composed into is decided here and nowhere else:
//
//   1. the run's own chain, with each subagent chain spliced in where it was
//      spawned (`spliceSubagentChains`), under one cap over every chain;
//   2. a harness's report of a model call the proxy already observed on that
//      chain carries neither tokens nor cost (`withoutLateReports`);
//   3. one model call reported by several sources is one frame
//      (`withoutDuplicateModelCalls`).
//
// A reader that composed these itself would fold different frames from the
// Run page the day one of the three changed.
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  type RunFrame,
  spliceSubagentChains,
  tachoFrame,
  type TachoFrameRowLike,
  withoutDuplicateModelCalls,
} from "./run-frames";

/**
 * The most frames a transcript folds. The Run page reads a run to this cap,
 * and so does every other reader of the run's steps, so a long run's summary
 * covers the frames the page shows.
 */
export const TRANSCRIPT_FRAME_CAP = 10_000;

/** Frames read to a cap, and whether the cap cut the read short. */
export interface FrameRead {
  frames: RunFrame[];
  complete: boolean;
}

/**
 * How a reader reaches one run's chains. Each read answers at most `cap`
 * frames and says whether there were more.
 */
export interface RunChainReads {
  /** The run's own chain, from its first frame, in sequence order. */
  own: (cap: number) => Promise<FrameRead>;
  /**
   * Every subagent chain under the run, each in sequence order. Null for a
   * run that records no subagent chains (a ledger run), and for a reader
   * built without a subagent store.
   */
  subagents: ((cap: number) => Promise<FrameRead>) | null;
}

/**
 * Every frame of the run up to `cap`, its subagents' included: the run's own
 * chain with each subagent chain spliced in where it was spawned. A subagent
 * records on a chain of its own, and the run's cost already counts those
 * chains; a transcript that read only the root showed none of the work they
 * did.
 *
 * The cap is over the frames of every chain together. The run's own chain
 * comes first and subagent frames fill what is left. `complete` is false
 * when the cap cut either read short.
 */
export async function readRunChains(
  reads: RunChainReads,
  cap: number,
): Promise<FrameRead> {
  if (reads.subagents === null) return reads.own(cap);
  const [own, children] = await Promise.all([
    reads.own(cap),
    reads.subagents(cap),
  ]);
  const kept = children.frames.slice(0, Math.max(0, cap - own.frames.length));
  return {
    frames: spliceSubagentChains(own.frames, kept),
    complete:
      own.complete &&
      children.complete &&
      kept.length === children.frames.length,
  };
}

/**
 * A wrapped run's frames with the harness's reports of model calls the proxy
 * had already begun observing stripped of their cost and usage.
 *
 * Once the loopback proxy observes a chain's model calls, it meters them. The
 * harness's own report of a later call on the same chain is a second account
 * of a call already counted. Chains are metered one by one, so the rule holds
 * per chain, in the order each chain recorded its frames. The intake folds
 * session totals by the same rule (`usageCountedEvents`). Mutates and returns
 * `frames`.
 */
export function withoutLateReports<T extends RunFrame[]>(frames: T): T {
  const observed = new Set<string>();
  for (const frame of frames) {
    const chain = frame.chain?.sessionUuid ?? "";
    if (frame.usageObserved) observed.add(chain);
    else if (observed.has(chain) && frame.type === "llm_call") {
      frame.usage = null;
      frame.costMicros = null;
    }
  }
  return frames;
}

/**
 * The frames a run's transcript folds, up to `cap`: every chain spliced
 * (`readRunChains`), late harness reports uncounted (`withoutLateReports`),
 * and each model call once (`withoutDuplicateModelCalls`). Every reader that
 * folds a run's steps reads its frames here.
 */
export async function readTranscriptFrames(
  reads: RunChainReads,
  cap: number,
): Promise<FrameRead> {
  const read = await readRunChains(reads, cap);
  return {
    frames: withoutDuplicateModelCalls(withoutLateReports(read.frames)),
    complete: read.complete,
  };
}

/** Where a subagent read resumes: the last chain and seq it returned. */
export interface SubagentChainPosition {
  sessionUuid: string;
  seq: number;
}

/**
 * A read of every subagent chain under a root session from `tacho_events`,
 * ordered by chain then seq. `selectTachoSubagentEvents` in
 * `@oxagen/telemetry` is the store's; tests pass their own.
 */
export type SubagentRowRead = (args: {
  rootSessionUuid: string;
  sessionUuids?: readonly string[];
  after: SubagentChainPosition | null;
  limit: number;
}) => Promise<TachoFrameRowLike[]>;

/**
 * The subagent read of a wrapped run: every chain under `rootSessionUuid`,
 * in one read of `cap + 1` rows so a full read can be told from a cut one.
 *
 * With `listChains`, the read names the chains Postgres holds under the root
 * (`listSubagentSessions`), and ClickHouse reads only their ranges; when
 * Postgres lists none, nothing is read. Without it, the read filters on the
 * root alone and scans every chain in the workspace.
 */
export function subagentChainRead(
  read: SubagentRowRead,
  rootSessionUuid: string,
  listChains?: (rootSessionUuid: string) => Promise<string[]>,
): (cap: number) => Promise<FrameRead> {
  return async (cap) => {
    let sessionUuids: string[] | undefined;
    if (listChains !== undefined) {
      sessionUuids = await listChains(rootSessionUuid);
      if (sessionUuids.length === 0) return { frames: [], complete: true };
    }
    const rows = await read({
      rootSessionUuid,
      after: null,
      limit: cap + 1,
      ...(sessionUuids === undefined ? {} : { sessionUuids }),
    });
    const frames = rows.map(tachoFrame);
    return frames.length > cap
      ? { frames: frames.slice(0, cap), complete: false }
      : { frames, complete: true };
  };
}

/**
 * The `session_uuid` of every subagent chain under a root session, fenced to
 * the workspace. Each chain registers its session row before its first frame
 * reaches ClickHouse, so this list names every chain a frame read can find,
 * and `tacho_sessions_root_idx` answers it.
 */
export function subagentSessionsQuery(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  rootSessionUuid: string,
) {
  const sessions = schema.tachoSessions;
  return db
    .select({ sessionUuid: sessions.sessionUuid })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.rootSessionUuid, rootSessionUuid),
        ne(sessions.sessionUuid, rootSessionUuid),
      ),
    );
}

/** `subagentSessionsQuery` run inside the caller's tenant scope. */
export async function listSubagentSessions(
  scope: { orgId: string; workspaceId: string },
  rootSessionUuid: string,
): Promise<string[]> {
  const rows = await withTenantDb((tx) =>
    subagentSessionsQuery(tx, scope, rootSessionUuid),
  );
  return rows.map((r) => r.sessionUuid);
}

/**
 * One subagent chain under a root session, as its `tacho.sessions` row
 * records it: its place in the run, its length and its seal (#3823). Every
 * reader that answers a run's chains one by one reads them here: the chain
 * heads on `get_run`, the chain walk on `get_run_chain` and the export.
 */
export interface SubagentChainRow {
  sessionUuid: string;
  /** `tacho.sessions.id`, the key a chain's checkpoints are stored under. */
  sessionId: string;
  parentSessionUuid: string | null;
  subagentId: string | null;
  subagentType: string | null;
  spawnToolUseId: string | null;
  /**
   * The chain's next free seq, as ingest stores it (`last.seq + 1`). Ingest
   * moves it before the frame reaches ClickHouse, so it can name a frame no
   * read returns yet.
   */
  seqCount: number;
  startedAt: Date;
  lastEventAt: Date;
  /** The row's birth on the server's clock, which the frames' TTL counts from. */
  createdAt: Date;
  finalHash: string | null;
  sealedAt: Date | null;
  enforcementTier: string;
  /** As stored: a jsonb list of gap kinds. */
  completenessGaps: unknown;
  replayGrade: string | null;
}

/**
 * The subagent chains under a root session, fenced to the workspace, in the
 * order they started. `sessionUuids` narrows the list to those chains, so a
 * reader can ask whether one chain belongs to the run. `limit` caps the list;
 * a caller that asks for one more than it shows can tell a cut list.
 */
export function subagentChainsQuery(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  rootSessionUuid: string,
  options: { sessionUuids?: readonly string[]; limit?: number } = {},
) {
  const sessions = schema.tachoSessions;
  const query = db
    .select({
      sessionUuid: sessions.sessionUuid,
      sessionId: sessions.id,
      parentSessionUuid: sessions.parentSessionUuid,
      subagentId: sessions.subagentId,
      subagentType: sessions.subagentType,
      spawnToolUseId: sessions.spawnToolUseId,
      seqCount: sessions.seqCount,
      startedAt: sessions.startedAt,
      lastEventAt: sessions.lastEventAt,
      createdAt: sessions.createdAt,
      finalHash: sessions.finalHash,
      sealedAt: sessions.sealedAt,
      enforcementTier: sessions.enforcementTier,
      completenessGaps: sessions.completenessGaps,
      replayGrade: sessions.replayGrade,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.orgId, scope.orgId),
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.rootSessionUuid, rootSessionUuid),
        ne(sessions.sessionUuid, rootSessionUuid),
        options.sessionUuids === undefined
          ? undefined
          : inArray(sessions.sessionUuid, [...options.sessionUuids]),
      ),
    )
    .orderBy(asc(sessions.startedAt), asc(sessions.id))
    .$dynamic();
  return options.limit === undefined ? query : query.limit(options.limit);
}

/** `subagentChainsQuery` run inside the caller's tenant scope. */
export async function listSubagentChains(
  scope: { orgId: string; workspaceId: string },
  rootSessionUuid: string,
  options: { sessionUuids?: readonly string[]; limit?: number } = {},
): Promise<SubagentChainRow[]> {
  if (options.sessionUuids !== undefined && options.sessionUuids.length === 0)
    return [];
  return withTenantDb((tx) =>
    subagentChainsQuery(tx, scope, rootSessionUuid, options),
  );
}
