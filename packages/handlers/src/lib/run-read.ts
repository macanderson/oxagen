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
  listSubagentChains,
  listSubagentSessions,
  type RunChainReads,
  type RunFrame,
  type RunStore,
  subagentChainRead,
  type SubagentChainRow,
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
   * body read) is built without it; `runChainReads` reads no subagent frames
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
  /**
   * The subagent chains under a root session with their session rows, from
   * Postgres (`listSubagentChains`). A reader that answers the chains one by
   * one reads them here: `get_run`'s chain heads and the chain walk. Absent,
   * such a reader answers no chains.
   */
  tachoChains?: (
    rootSessionUuid: string,
    options?: { sessionUuids?: readonly string[]; limit?: number },
  ) => Promise<SubagentChainRow[]>;
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
    ...(enabled
      ? {}
      : {
          // Turning automatic accounts off hides what Oxagen wrote, not the
          // title the harness gave the session.
          name:
            run.source === "tacho"
              ? (run.row.session.harnessTitle ?? null)
              : null,
          summary: null,
          canSummarize: false,
          enrichmentError: undefined,
        }),
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
 * The frames of one subagent chain strictly after `afterSeq`, ascending, at
 * most `limit`: `readFrames` for a chain other than the run's own (#3823).
 *
 * The read names the chain and is fenced by the run's root, so it returns
 * nothing from a chain of another run. It is bounded above the same way, at
 * `afterSeq + limit`, and reads past the window only when the window came
 * back short of a chain that is longer than it. A position is compared on an
 * unsigned seq and nothing lies below seq 0, so the first page reads from
 * the chain's start.
 */
export async function readChainFrames(
  deps: RunReadDeps,
  rootSessionUuid: string,
  chain: Pick<SubagentChainRow, "sessionUuid" | "seqCount">,
  afterSeq: string,
  limit: number,
): Promise<RunFrame[]> {
  const read = deps.tachoSubagentFrames;
  if (read === undefined) return [];
  const page = (after: number, want: number, throughSeq?: number) =>
    read({
      rootSessionUuid,
      sessionUuids: [chain.sessionUuid],
      after: after < 0 ? null : { sessionUuid: chain.sessionUuid, seq: after },
      ...(throughSeq === undefined ? {} : { throughSeq }),
      limit: want,
    });
  const after = Number(afterSeq);
  const through = after + limit;
  const rows = await page(after, limit, through);
  const head = chain.seqCount - 1;
  const last = rows.at(-1)?.seq;
  if (rows.length < limit && (through < head || last === through)) {
    rows.push(...(await page(through, limit - rows.length)));
  }
  return rows
    .map(tachoFrame)
    .filter((frame) => frame.chain?.sessionUuid === chain.sessionUuid);
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
 * How `deps` reads the run's chains (`RunChainReads` in `@oxagen/run-ledger`):
 * its own chain page by page, and for a wrapped run every subagent chain
 * under it. What the reads are composed into, and which frames a transcript
 * folds, is decided in `@oxagen/run-ledger` (`readRunChains`,
 * `readTranscriptFrames`), so the summary job composes the same frames.
 */
export function runChainReads(
  deps: RunReadDeps,
  run: ResolvedRun,
): RunChainReads {
  return {
    own: (cap) => readAllFrames(deps, run, cap),
    subagents:
      run.source === "tacho" && deps.tachoSubagentFrames !== undefined
        ? subagentChainRead(
            deps.tachoSubagentFrames,
            run.sessionUuid,
            deps.tachoChildSessions,
          )
        : null,
  };
}

/**
 * The one frame at `seq`, or null. `sessionUuid` names the chain it was
 * recorded on: omitted, or the run's own session, it is the run's own chain.
 * Any other session is read as a subagent chain under the run's root, so a
 * session of another run finds nothing, and neither does any session on a
 * ledger run, which has one chain (#3823).
 */
export async function readFrameAt(
  deps: RunReadDeps,
  run: ResolvedRun,
  seq: string,
  sessionUuid?: string,
): Promise<RunFrame | null> {
  const chain = sessionUuid?.toLowerCase();
  if (chain !== undefined && run.source === "ledger") return null;
  if (run.source === "tacho") {
    if (chain !== undefined && chain !== run.sessionUuid)
      return readSubagentFrameAt(deps, run.sessionUuid, chain, seq);
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
 * The frame at `seq` on one subagent chain under `rootSessionUuid`, or null.
 * The read names the chain and is fenced by the root, so a chain of another
 * run answers nothing. Its position is a (session, seq) tuple compared on an
 * unsigned seq, and nothing lies below seq 0, so the chain's first frame is
 * read from the chain's start and `throughSeq` stops the read at the frame.
 */
async function readSubagentFrameAt(
  deps: RunReadDeps,
  rootSessionUuid: string,
  sessionUuid: string,
  seq: string,
): Promise<RunFrame | null> {
  if (deps.tachoSubagentFrames === undefined) return null;
  const at = Number(seq);
  const [row] = await deps.tachoSubagentFrames({
    rootSessionUuid,
    sessionUuids: [sessionUuid],
    after: at === 0 ? null : { sessionUuid, seq: at - 1 },
    throughSeq: at,
    limit: 1,
  });
  const frame = row ? tachoFrame(row) : undefined;
  return frame !== undefined &&
    frame.seq === seq &&
    frame.chain?.sessionUuid === sessionUuid
    ? frame
    : null;
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
    tachoChildSessions: (root) => listSubagentSessions(requireScope(), root),
    tachoChains: (root, options) =>
      listSubagentChains(requireScope(), root, options),
    readEnrichmentEnabled: readRunEnrichmentEnabled,
  };
}
