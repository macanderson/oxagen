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
  type ReadRunRollups,
  type RunQueries,
  runScope,
  type RunScope,
  type TachoSessionRow,
  toLedgerRunItem,
  toTachoRunItem,
} from "../run.list";
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
  const run = await resolveSource(deps, scope, publicId);
  const enabled = deps.readEnrichmentEnabled
    ? await deps.readEnrichmentEnabled(scope)
    : true;
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
  const witnessFor = await deps.readWitnessFor(scope, publicId);
  if (witnessFor !== null && ctx.apiKeyId !== null) throw runNotFound();
  return { ...run, witnessFor };
}

async function resolveSource(
  deps: RunReadDeps,
  scope: RunScope,
  publicId: string,
): Promise<ResolvedSource> {
  if (publicId.startsWith("tse_")) {
    const row = await deps.queries.tachoSession(scope, publicId);
    if (!row) throw runNotFound();
    const costs = await deps.readRunRollups(scope, [publicId]);
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

/** The frames strictly after `afterSeq`, ascending, at most `limit`. */
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
  const rows = await deps.tachoFrames({
    sessionUuid: run.sessionUuid,
    afterSeq: Number(afterSeq),
    limit,
  });
  return rows.map(tachoFrame);
}

/**
 * Every frame of the run up to `cap`, read page by page. Answers whether the
 * cap cut the read short, so a caller can say so rather than present a
 * prefix as the whole.
 */
export async function readAllFrames(
  deps: RunReadDeps,
  run: ResolvedRun,
  cap: number,
): Promise<{ frames: RunFrame[]; complete: boolean }> {
  const frames: RunFrame[] = [];
  let after = startCursorSeq(run);
  for (;;) {
    const want = Math.min(FRAME_READ_MAX, cap - frames.length + 1);
    if (want <= 0) break;
    const page = await readFrames(deps, run, after, want);
    frames.push(...page);
    const last = page.at(-1);
    if (!last || page.length < want) break;
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
  const own = await readAllFrames(deps, run, cap);
  if (run.source !== "tacho" || deps.tachoSubagentFrames === undefined) {
    return own;
  }
  const children: RunFrame[] = [];
  let after: { sessionUuid: string; seq: number } | null = null;
  let complete = own.complete;
  for (;;) {
    const room = cap - own.frames.length - children.length;
    if (room <= 0) {
      // Past the cap: ask for one more row only to learn whether one exists.
      const probe = await deps.tachoSubagentFrames({
        rootSessionUuid: run.sessionUuid,
        after,
        limit: 1,
      });
      if (probe.length > 0) complete = false;
      break;
    }
    const want = Math.min(FRAME_READ_MAX, room);
    const page = await deps.tachoSubagentFrames({
      rootSessionUuid: run.sessionUuid,
      after,
      limit: want,
    });
    children.push(...page.map(tachoFrame));
    const last = page.at(-1);
    if (!last || page.length < want || last.sessionUuid === undefined) break;
    after = { sessionUuid: last.sessionUuid, seq: last.seq };
  }
  return {
    frames: spliceSubagentChains(own.frames, children),
    complete,
  };
}

/** The one frame at `seq`, or null. */
export async function readFrameAt(
  deps: RunReadDeps,
  run: ResolvedRun,
  seq: string,
): Promise<RunFrame | null> {
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
    readEnrichmentEnabled: readRunEnrichmentEnabled,
  };
}
