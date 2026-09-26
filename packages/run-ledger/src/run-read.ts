// run-read.ts — the frames of a run as its transcript reads them, composed
// once (ADR-182).
//
// Two readers fold a run's steps: `get_run_transcript`, which the Run page
// draws, and the `run.enrich` job behind `summarize_run`, which writes the
// run's account from them. Each reaches the stores its own way, so each passes the reads it has.
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
//
// A page of the transcript read from a cursor reads a window of the run
// instead of the whole of it (`readTranscriptWindow`, #3823): the run's own
// chain from a frame on, with the subagent chains spawned inside the window,
// composed by the same three rules.
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
 *
 * `observed` names the chains whose proxy began observing before `frames`
 * start (the run's own chain is `""`), for a read that starts partway into
 * the run (`readTranscriptWindow`).
 */
export function withoutLateReports<T extends RunFrame[]>(
  frames: T,
  observed: Iterable<string> = [],
): T {
  const seen = new Set<string>(observed);
  for (const frame of frames) {
    const chain = frame.chain?.sessionUuid ?? "";
    if (frame.usageObserved) seen.add(chain);
    else if (seen.has(chain) && frame.type === "llm_call") {
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

// ── A window of the run (#3823) ─────────────────────────────────────────────

/**
 * How a reader reaches a window of one run: its own chain from a frame on,
 * the subagent chains listed under it, and the frames of the chains it names.
 */
export interface RunChainWindowReads {
  /** The run's own chain from the frame at `fromSeq` on, in sequence order. */
  own: (fromSeq: string, cap: number) => Promise<FrameRead>;
  /**
   * The subagent chains under the run with their session rows
   * (`listSubagentChains`). Null for a run that records none.
   */
  chains: (() => Promise<SubagentChainRow[]>) | null;
  /** The named subagent chains, each whole and in sequence order. */
  subagents: (
    sessionUuids: readonly string[],
    cap: number,
  ) => Promise<FrameRead>;
}

/** Where a window of a run starts, and what it carries from before it. */
export interface TranscriptWindowStart {
  /** The seq of the window's first frame on the run's own chain. */
  fromSeq: string;
  /**
   * The proxy observed a model call on the run's own chain before the window,
   * so the harness's reports inside it are late (`withoutLateReports`).
   */
  observed: boolean;
  /**
   * A subagent chain whose session row moved after this instant may have
   * recorded a frame since the last read. Null when the reader cannot say,
   * which counts every chain as moved.
   */
  movedAfter: Date | null;
  /** The subagent chains the window must hold: the ones a cursor names. */
  holds: readonly string[];
}

/** Where a subagent chain sits against a window of its run. */
type ChainPlace =
  /** A `subagent_start` inside the window spawned it, or its parent chain. */
  | "spawned"
  /** It records no spawn and began inside the window, so it sits by time. */
  | "loose"
  /** It began before the window, so its frames sit before the window. */
  | "before"
  /** It names a spawn the window does not hold, yet began inside the window. */
  | "unplaced";

/**
 * The subagent chains a window holds, and how many frames of the run's own
 * chain it keeps so that every chain it holds is read whole under `cap`.
 * Null when only a read of the whole run can place a chain: it moved since
 * the last read, or a cursor names it, or the window cannot hold it.
 *
 * A chain is placed where `spliceSubagentChains` places it in a read of the
 * whole run. One spawned by a `subagent_start` inside the window sits after
 * that frame, and so does every chain under it. One that records no spawn
 * sits by the time it began. Any other chain began before the window, sits
 * before it, and is not read. Such a chain that moved since the last read
 * may hold a frame the reader was not sent, and only a read of the whole run
 * can place it. So can a chain that names a spawn the window lacks but began
 * inside the window, as a subagent left running in the background does.
 *
 * The match is stricter than the splice's. A chain matched on its subagent
 * id alone must name no spawning call, and must have begun inside the
 * window: a subagent resumed under the id it had records a second chain,
 * and the splice gives the first chain to the first spawn. A chain the
 * stricter match leaves out reads as `unplaced` or `before`, so the answer
 * is a read of the whole run, never a chain in the wrong place. The splice
 * over the window still decides the order of the frames.
 *
 * The run's own chain is kept to the longest prefix whose frames, with the
 * frames (`seqCount`) of every chain placed inside that prefix, fit under
 * `cap`. So no chain is read in part, and the next window begins at or
 * before the first chain this one left out.
 */
function windowChains(
  own: readonly RunFrame[],
  chains: readonly SubagentChainRow[],
  start: TranscriptWindowStart,
  cap: number,
): { read: string[]; keep: number } | null {
  const openedAt = own[0]?.observedAt.getTime() ?? Number.POSITIVE_INFINITY;
  const spawns = own.flatMap((frame, index) =>
    frame.spawn === undefined ? [] : [{ index, spawn: frame.spawn }],
  );
  const byUuid = new Map(chains.map((chain) => [chain.sessionUuid, chain]));
  // `needs`: how many frames of the run's own chain the window must keep to
  // hold the chain. A spawned chain needs its spawn; a loose one the frames
  // before the first frame observed after it began.
  const placed = new Map<string, { place: ChainPlace; needs: number }>();
  const placing = new Set<string>();
  const placeOf = (
    chain: SubagentChainRow,
  ): { place: ChainPlace; needs: number } => {
    const known = placed.get(chain.sessionUuid);
    if (known !== undefined) return known;
    placing.add(chain.sessionUuid);
    const parent =
      chain.parentSessionUuid === null ||
      placing.has(chain.parentSessionUuid)
        ? undefined
        : byUuid.get(chain.parentSessionUuid);
    const began = chain.startedAt.getTime();
    let answer: { place: ChainPlace; needs: number };
    if (parent !== undefined) {
      // A chain under another subagent sits inside its parent's chain.
      answer = placeOf(parent);
    } else {
      const spawn =
        spawns.find(
          ({ spawn }) =>
            chain.spawnToolUseId !== null &&
            spawn.toolUseId === chain.spawnToolUseId,
        ) ??
        spawns.find(
          ({ spawn }) =>
            chain.spawnToolUseId === null &&
            chain.subagentId !== null &&
            spawn.subagentId === chain.subagentId &&
            began >= openedAt,
        );
      if (spawn !== undefined)
        answer = { place: "spawned", needs: spawn.index + 1 };
      else if (began < openedAt) answer = { place: "before", needs: 0 };
      else if (chain.spawnToolUseId === null && chain.subagentId === null) {
        const next = own.findIndex(
          (frame) => frame.observedAt.getTime() > began,
        );
        answer = { place: "loose", needs: next === -1 ? own.length : next };
      } else answer = { place: "unplaced", needs: 0 };
    }
    placing.delete(chain.sessionUuid);
    placed.set(chain.sessionUuid, answer);
    return answer;
  };
  const moved = (chain: SubagentChainRow) =>
    start.movedAfter === null ||
    chain.lastEventAt.getTime() > start.movedAfter.getTime();
  const held = new Set(start.holds);
  const inside: { uuid: string; needs: number; size: number }[] = [];
  for (const chain of chains) {
    const { place, needs } = placeOf(chain);
    if (place === "unplaced") return null;
    if (place === "before") {
      if (moved(chain) || held.has(chain.sessionUuid)) return null;
      continue;
    }
    inside.push({
      uuid: chain.sessionUuid,
      needs,
      size: Math.max(0, chain.seqCount),
    });
  }
  inside.sort((a, b) => a.needs - b.needs);
  // The longest prefix `keep` of the run's own chain with `keep` plus the
  // frames of the chains it holds under `cap`. Both grow with `keep`, so
  // walk down from the whole read.
  let keep = Math.min(own.length, cap);
  let holding = inside.filter((chain) => chain.needs <= keep).length;
  let size = inside
    .slice(0, holding)
    .reduce((sum, chain) => sum + chain.size, 0);
  while (keep > 0 && keep + size > cap) {
    keep -= 1;
    while (holding > 0 && (inside[holding - 1]?.needs ?? 0) > keep) {
      holding -= 1;
      size -= inside[holding]?.size ?? 0;
    }
  }
  // A window that keeps none of the run's own chain holds nothing to page.
  if (keep === 0 && own.length > 0) return null;
  return {
    read: inside.slice(0, holding).map((chain) => chain.uuid),
    keep,
  };
}

/**
 * A window of the run's frames, as `readTranscriptFrames` composes them over
 * the whole run: the run's own chain from `start.fromSeq`, each subagent
 * chain the window holds spliced in where it was spawned, late harness
 * reports uncounted, and each model call once, up to `cap` frames.
 *
 * Null when only a read of the whole run can answer (`windowChains`), and
 * when the chains held more frames than their session rows said, since a
 * chain cut in part would lose its tail from every later window.
 *
 * `complete` is false when the cap cut the window short of the run's last
 * frame, whether on the run's own chain or to hold a chain whole.
 */
export async function readTranscriptWindow(
  reads: RunChainWindowReads,
  start: TranscriptWindowStart,
  cap: number,
): Promise<FrameRead | null> {
  const [own, chains] = await Promise.all([
    reads.own(start.fromSeq, cap),
    reads.chains === null ? Promise.resolve([]) : reads.chains(),
  ]);
  const plan = windowChains(own.frames, chains, start, cap);
  if (plan === null) return null;
  const children =
    plan.read.length === 0
      ? { frames: [], complete: true }
      : await reads.subagents(plan.read, cap);
  const root = own.frames.slice(0, plan.keep);
  if (!children.complete || root.length + children.frames.length > cap)
    return null;
  const frames = spliceSubagentChains(root, children.frames);
  return {
    frames: withoutDuplicateModelCalls(
      withoutLateReports(frames, start.observed ? [""] : []),
    ),
    complete: own.complete && plan.keep === own.frames.length,
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
 * The read of named subagent chains under `rootSessionUuid`, each whole, in
 * one read of `cap + 1` rows so a full read can be told from a cut one. A
 * window of the run reads the chains it holds here
 * (`RunChainWindowReads.subagents`).
 */
export function namedSubagentChainRead(
  read: SubagentRowRead,
  rootSessionUuid: string,
): (sessionUuids: readonly string[], cap: number) => Promise<FrameRead> {
  return async (sessionUuids, cap) => {
    if (sessionUuids.length === 0) return { frames: [], complete: true };
    const rows = await read({
      rootSessionUuid,
      sessionUuids,
      after: null,
      limit: cap + 1,
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
