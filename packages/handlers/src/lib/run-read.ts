import { readRunEnrichmentEnabled } from "./run-enrichment";
// run-read.ts — resolving a run in the caller's workspace and reading its
// frames from the store that recorded it (ADR-058).
//
// `arun_…` is an evidence-ledger run: the header row comes from
// `agent.agent_runs` with its identity joins and its latest seal, the frames
// from `agent.agent_run_events` through the ledger store. `tse_…` is a
// wrapped session: the header from `tacho.sessions`, the frames from
// ClickHouse `tacho_events` through the telemetry read seam. Both readers
// answer the one `RunFrame` shape (`@oxagen/run-ledger`), cursored on the
// run's own sequence, so every capability over a recording reads it the same
// way.
//
// A run the caller's workspace does not hold is `not_found`, whichever store
// minted its id: the ledger store fences the org through RLS and the identity
// query fences the workspace as well, which also holds on a stack that runs
// with the RLS bypass on. A witness run is `not_found` to an API-key caller
// (ADR-064): a worker holds API keys and never sees a witness or its run.
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import type { RunItem } from "@oxagen/oxagen/contracts/run.list";
import {
  createPostgresRunStore,
  ledgerFrame,
  type RunFrame,
  type RunStore,
  spliceSubagentChains,
  tachoFrame,
} from "@oxagen/run-ledger";
import { deferredEvidenceArchive } from "@oxagen/run-ledger/evidence-store";
import {
  selectTachoEvents,
  selectTachoSubagentEvents,
} from "@oxagen/telemetry";
import {
  ledgerEnrichment,
  type LedgerRunRecord,
  type LedgerRunRow,
  postgresReadRunRollups,
  postgresRunQueries,
  postgresTachoChildSessions,
  type ReadRunRollups,
  type RunQueries,
  runScope,
  type RunScope,
  type TachoSessionRow,
  toLedgerRunItem,
  toTachoRunItem,
} from "../run.list";
import { requireScope } from "@oxagen/tenancy";
import { readWitnessFor } from "./proof";

/** The most frames one read of either store returns. */
const FRAME_READ_MAX = 500;

type ResolvedSource =
  | {
      source: "ledger";
      /** `agent_runs.id`. */
      runId: string;
      row: LedgerRunRow;
      record: LedgerRunRecord;
      item: RunItem;
    }
  | {
      source: "tacho";
      sessionUuid: string;
      row: TachoSessionRow;
      item: RunItem;
    };

export type ResolvedRun = ResolvedSource & {
  /** The worker run this run witnessed (ADR-064); null for any other run. */
  witnessFor: string | null;
};

type TachoFrameReader = typeof selectTachoEvents;
type TachoSubagentFrameReader = typeof selectTachoSubagentEvents;

export type RunReadDeps = {
  queries: Pick<
    RunQueries,
    "ledgerIdentity" | "ledgerRollups" | "ledgerSeals" | "tachoSession"
  >;
  store: Pick<RunStore, "getRunByPublicId" | "readAttemptEventsSince">;
  readRunRollups: ReadRunRollups;
  /** The worker run a witness run was for (ADR-064); null for any other run. */
  readWitnessFor: (scope: RunScope, runId: string) => Promise<string | null>;
  tachoFrames: TachoFrameReader;
  /**
   * Every subagent chain under a wrapped run's root session. Optional so a
   * reader that only walks the run's own chain (the chain verifier, the frame
   * body read) is built without it; `readRunFrames` reads no subagent frames
   * when it is absent.
   */
  tachoSubagentFrames?: TachoSubagentFrameReader;
  /**
   * The `session_uuid` of every subagent chain under a root session, from
   * Postgres. With it, the subagent read names its chains and ClickHouse
   * reads only their ranges; without it, the read filters on the root alone
   * and scans every chain in the workspace.
   */
  tachoChildSessions?: (rootSessionUuid: string) => Promise<string[]>;
  readEnrichmentEnabled?: typeof readRunEnrichmentEnabled;
};

export const runNotFound = () =>
  new HandlerError({ code: "not_found", reason: "run_not_found" });

/**
 * The run behind a public id, with its header and its witness link, or
 * `not_found`: for a run outside the caller's workspace, and for a witness run
 * when the caller holds an API key.
 */
export async function resolveRun(
  deps: RunReadDeps,
  ctx: CapabilityContext,
  publicId: string,
): Promise<ResolvedRun> {
  const scope = runScope(ctx);
  // The three reads are independent; each is fenced to the caller's scope.
  const [run, enabled, witnessFor] = await Promise.all([
    resolveSource(deps, scope, publicId),
    deps.readEnrichmentEnabled
      ? deps.readEnrichmentEnabled(scope)
      : Promise.resolve(true),
    deps.readWitnessFor(scope, publicId),
  ]);
  run.item = {
    ...run.item,
    enrichmentEnabled: enabled,
    ...(enabled ? {} : { name: null, summary: null, canSummarize: false }),
  };
  if (witnessFor !== null && ctx.apiKeyId !== null) throw runNotFound();
  return { ...run, witnessFor };
}

async function resolveSource(
  deps: RunReadDeps,
  scope: RunScope,
  publicId: string,
): Promise<ResolvedSource> {
  if (publicId.startsWith("tse_")) {
    const [row, costs] = await Promise.all([
      deps.queries.tachoSession(scope, publicId),
      deps.readRunRollups(scope, [publicId]),
    ]);
    if (!row) throw runNotFound();
    return {
      source: "tacho",
      sessionUuid: row.session.sessionUuid,
      row,
      item: toTachoRunItem(row, costs.get(publicId)),
    };
  }
  const summary = await deps.store.getRunByPublicId(publicId);
  if (!summary) throw runNotFound();
  const row = await deps.queries.ledgerIdentity(scope, summary.runId);
  if (!row) throw runNotFound();
  const [enrich, costs] = await Promise.all([
    ledgerEnrichment(deps, scope, [summary.runId]),
    deps.readRunRollups(scope, [publicId]),
  ]);
  const record = enrich(row);
  return {
    source: "ledger",
    runId: summary.runId,
    row,
    record,
    item: toLedgerRunItem(record, costs.get(publicId)),
  };
}

/**
 * The cursor a read from the start uses: the ledger numbers frames from 1,
 * a wrapped session from 0.
 */
export function startCursorSeq(run: ResolvedRun): string {
  return run.source === "ledger" ? "0" : "-1";
}

/**
 * The frames strictly after `afterSeq`, ascending, at most `limit`.
 *
 * A wrapped session's read is bounded above as well: `tacho_events` is read
 * with `FINAL`, and without an upper bound ClickHouse reads the chain from
 * `afterSeq` to its end whatever the limit says. A chain numbers its frames
 * without holes, so `afterSeq + limit` is the last seq a full read can reach.
 * A chain with a recorded break can skip seqs, and then the window holds
 * fewer frames than asked; the rest are read past the window, unbounded,
 * only in that case.
 */
export async function readFrames(
  deps: RunReadDeps,
  run: ResolvedRun,
  afterSeq: string,
  limit: number,
): Promise<RunFrame[]> {
  if (run.source === "ledger") {
    const events = await deps.store.readAttemptEventsSince(
      run.runId,
      afterSeq,
      limit,
    );
    return events.map(ledgerFrame);
  }
  const after = Number(afterSeq);
  const through = after + limit;
  const rows = await deps.tachoFrames({
    sessionUuid: run.sessionUuid,
    afterSeq: after,
    throughSeq: through,
    limit,
  });
  const head = run.row.session.seqCount - 1;
  const last = rows.at(-1)?.seq;
  if (rows.length < limit && (through < head || last === through)) {
    const rest = await deps.tachoFrames({
      sessionUuid: run.sessionUuid,
      afterSeq: through,
      limit: limit - rows.length,
    });
    rows.push(...rest);
  }
  return rows.map(tachoFrame);
}

/**
 * Every frame of the run up to `cap`. Answers whether the cap cut the read
 * short, so a caller can say so rather than present a prefix as the whole.
 * A wrapped session reads in one bounded query; the ledger reads page by
 * page.
 */
export async function readAllFrames(
  deps: RunReadDeps,
  run: ResolvedRun,
  cap: number,
): Promise<{ frames: RunFrame[]; complete: boolean }> {
  const frames: RunFrame[] = [];
  let after = startCursorSeq(run);
  const page = run.source === "tacho" ? cap + 1 : FRAME_READ_MAX;
  for (;;) {
    const want = Math.min(page, cap - frames.length + 1);
    if (want <= 0) break;
    const read = await readFrames(deps, run, after, want);
    frames.push(...read);
    const last = read.at(-1);
    if (!last || read.length < want) break;
    after = last.seq;
  }
  if (frames.length > cap) {
    return { frames: frames.slice(0, cap), complete: false };
  }
  return { frames, complete: true };
}

/**
 * Every frame of the run up to `cap`, its subagents' included: for a wrapped
 * run, the root session's chain with each subagent chain spliced in where it
 * was spawned (`spliceSubagentChains`). A subagent records on a chain of its
 * own, and the run's cost already counts those chains; a transcript that read
 * only the root showed none of the work they did. A ledger run has no
 * subagent chains and reads as `readAllFrames` does.
 *
 * The cap is over the frames of every chain together, and `complete` is
 * false when it cut either read short.
 */
export async function readRunFrames(
  deps: RunReadDeps,
  run: ResolvedRun,
  cap: number,
): Promise<{ frames: RunFrame[]; complete: boolean }> {
  if (run.source !== "tacho" || deps.tachoSubagentFrames === undefined) {
    return readAllFrames(deps, run, cap);
  }
  const [own, children] = await Promise.all([
    readAllFrames(deps, run, cap),
    readSubagentFrames(deps, deps.tachoSubagentFrames, run.sessionUuid, cap),
  ]);
  // The run's own chain comes first; subagent frames fill what is left.
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
 * The frames of every subagent chain under a root, up to `cap`, in one read
 * of `cap + 1` rows so a full read can be told from a cut one.
 */
async function readSubagentFrames(
  deps: RunReadDeps,
  read: TachoSubagentFrameReader,
  rootSessionUuid: string,
  cap: number,
): Promise<{ frames: RunFrame[]; complete: boolean }> {
  let sessionUuids: string[] | undefined;
  if (deps.tachoChildSessions !== undefined) {
    sessionUuids = await deps.tachoChildSessions(rootSessionUuid);
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
}

/** The one frame at `seq`, or null. */
export async function readFrameAt(
  deps: RunReadDeps,
  run: ResolvedRun,
  seq: string,
): Promise<RunFrame | null> {
  if (run.source === "tacho") {
    // Bounded at `seq` itself, so a missing frame reads nothing past it.
    const [row] = await deps.tachoFrames({
      sessionUuid: run.sessionUuid,
      afterSeq: Number(seq) - 1,
      throughSeq: Number(seq),
      limit: 1,
    });
    const frame = row ? tachoFrame(row) : undefined;
    return frame && frame.seq === seq ? frame : null;
  }
  const before = (BigInt(seq) - 1n).toString();
  const [frame] = await readFrames(deps, run, before, 1);
  return frame && frame.seq === seq ? frame : null;
}

/**
 * The ledger as every handler reads it. A compacted attempt's frames live in
 * its archive segment (spec §13.3), so a reader needs the archive; the seam
 * is deferred because handlers construct at module load, before the storage
 * driver's environment is required.
 */
export function ledgerStore(): RunStore {
  return createPostgresRunStore({ archive: deferredEvidenceArchive });
}

export function defaultRunReadDeps(): RunReadDeps {
  // Construction is pure: nothing connects until a read runs inside the scope.
  const ledger = ledgerStore();
  return {
    queries: postgresRunQueries,
    store: {
      getRunByPublicId: (id) => ledger.getRunByPublicId(id),
      readAttemptEventsSince: (id, after, limit) =>
        ledger.readAttemptEventsSince(id, after, limit),
    },
    readRunRollups: postgresReadRunRollups,
    readWitnessFor,
    tachoFrames: selectTachoEvents,
    tachoSubagentFrames: selectTachoSubagentEvents,
    tachoChildSessions: (root) =>
      postgresTachoChildSessions(requireScope(), root),
    readEnrichmentEnabled: readRunEnrichmentEnabled,
  };
}
