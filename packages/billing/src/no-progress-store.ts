/**
 * no-progress-store.ts — the reads and writes around the no-progress limit
 * (./no-progress.ts; spend spec, detector 1; #4490): the workspace's limit
 * from `workspace.no_progress_policy`, the run's tool calls and file changes
 * from the store that holds the run, and one `cost.no_progress_hits` row per
 * loop.
 *
 * `cost.run-progress` runs the check while a run is open. It reads the whole
 * run each pass, so every write here is idempotent: a loop keeps the row it
 * got when it reached the limit, and a later pass only raises `repeats` as
 * the loop grows. The mode, outcome, and pause block stay as they were at
 * that first pass.
 *
 * Every workspace starts at {@link NO_PROGRESS_DEFAULT_LIMIT} until its team
 * sets its own (decision 2). A policy row with no count is a team that
 * cleared the limit, and runs no check.
 *
 * Everything runs on the system connection with explicit org and workspace
 * predicates, since the job runs outside a tenant scope.
 */
import { schema, withSystemDb } from "@oxagen/database";
import { getCapability } from "@oxagen/oxagen/registry";
import { capabilityMutates } from "@oxagen/oxagen/types";
import { readTachoProgressFrames } from "@oxagen/telemetry";
import { and, eq, sql } from "drizzle-orm";
import type { ToolCallFrame } from "./cost-rollup";
import {
  loadRunSource,
  readRunToolCalls,
  type RunSource,
} from "./cost-rollup-store";
import {
  findNoProgressLoops,
  noProgressLimitOf,
  noProgressOutcome,
  type NoProgressFrame,
  type NoProgressLimit,
  type NoProgressLoop,
  type NoProgressMode,
  type NoProgressOutcome,
} from "./no-progress";

const policy = schema.noProgressPolicy;
const hits = schema.noProgressHits;

type NoProgressScope = { orgId: string; workspaceId: string };

/**
 * The limit every workspace starts at until its team sets its own (spend
 * plan, decision 2): 20 unchanged repeats, in observe mode, so no run is
 * paused until the team chooses enforced mode.
 */
export const NO_PROGRESS_DEFAULT_LIMIT: Readonly<NoProgressLimit> = {
  repeats: 20,
  mode: "observe",
};

/**
 * Why an enforced limit could not pause the run. The hit records it as
 * `pause_block`, and the Run page names it.
 *
 * - `run_sealed`: the run had ended before the check reached it.
 * - `no_host`: the run names no enrolled host to carry the pause.
 * - `host_revoked`: the run's host enrollment was revoked.
 * - `host_offline`: the run's host had not checked in for five minutes.
 * - `no_connection_point`: no host carries commands for the run. A ledger
 *   run's pause fences its evidence and refuses none of its agent's calls.
 * - `pause_unavailable`: the process that ran the check had no pause path
 *   installed.
 *
 * The first four are `commandBlockOf`'s reasons, the rule every run control
 * reads, so the Run page and the pause path agree.
 */
export const NO_PROGRESS_PAUSE_BLOCKS = [
  "run_sealed",
  "no_host",
  "host_revoked",
  "host_offline",
  "no_connection_point",
  "pause_unavailable",
] as const;
export type NoProgressPauseBlock = (typeof NO_PROGRESS_PAUSE_BLOCKS)[number];

/** The run a check reads, as the rollup found it. */
export interface NoProgressRun extends NoProgressScope {
  runId: string;
  /** A sealed run has ended, so nothing can pause it. */
  sealed: boolean;
}

/** One loop as `cost.no_progress_hits` records it. */
export interface NoProgressHit extends NoProgressLoop {
  limitRepeats: number;
  mode: NoProgressMode;
  outcome: NoProgressOutcome;
  /** Why an enforced limit did not pause the run; null otherwise. */
  pauseBlock: NoProgressPauseBlock | null;
}

/** A loop the pause names, with the key that makes its pause idempotent. */
export interface NoProgressPauseLoop extends NoProgressLoop {
  /** {@link pauseKeyOf}: the same loop gets the same key on every pass. */
  key: string;
}

/** What the check asks the pause path to do: pause `runId` for `loops`. */
export interface NoProgressPauseRequest extends NoProgressRun {
  /** The loops this pass found first, in the order each reached the limit. */
  loops: readonly NoProgressPauseLoop[];
  limit: NoProgressLimit;
}

/**
 * What the pause path did. `paused` means a pause is queued for the run's
 * host, now or by an earlier attempt for one of the same loops. The host
 * applies it at the next checkpoint, when the agent's next governed call
 * meets it.
 */
export type NoProgressPauseOutcome =
  | { paused: true; commandId: string }
  | { paused: false; block: NoProgressPauseBlock };

/**
 * Pause a run at its next checkpoint, on governed calls. It must be
 * idempotent by loop key: a request whose loops include one an earlier
 * request already paused for queues nothing and answers `paused`. That is
 * what keeps a retried check from pausing a run the operator has resumed
 * (#4503).
 */
export type PauseRun = (
  request: NoProgressPauseRequest,
) => Promise<NoProgressPauseOutcome>;

export interface NoProgressDeps {
  now: () => Date;
  readLimit: (scope: NoProgressScope) => Promise<NoProgressLimit | null>;
  loadRunSource: (runId: string) => Promise<RunSource | null>;
  readFrames: (source: RunSource) => Promise<NoProgressFrame[]>;
  /** The loops the run already has a row for, by {@link loopKeyOf}. */
  readRecorded: (run: NoProgressRun) => Promise<Set<string>>;
  writeHits: (
    run: NoProgressRun,
    rows: readonly NoProgressHit[],
    now: Date,
  ) => Promise<void>;
  /**
   * The pause path, or null when the process has none installed. With null,
   * an enforced limit records `would_pause` with `pause_unavailable`.
   */
  pauseRun: PauseRun | null;
}

/** What one check found. */
export interface NoProgressCheck {
  /** False when the workspace cleared its limit, or no store has the run. */
  checked: boolean;
  /** The run's loops at the limit, recorded earlier or now. */
  loops: number;
  /** The loops this check recorded for the first time. */
  newLoops: number;
  paused: boolean;
}

const UNCHECKED: NoProgressCheck = {
  checked: false,
  loops: 0,
  newLoops: 0,
  paused: false,
};

/** A loop's identity within its run, the key of its row. */
export function loopKeyOf(loop: {
  tool: string;
  inputDigest: string;
  outputDigest: string;
  loop: number;
}): string {
  return [loop.tool, loop.inputDigest, loop.outputDigest, loop.loop].join(
    "\u0000",
  );
}

/**
 * A loop's identity as the pause path stores it on the command it queues. It
 * names the same loop as {@link loopKeyOf}, in a form a JSON column can hold:
 * Postgres refuses the NUL character in `jsonb` text.
 */
export function pauseKeyOf(loop: {
  tool: string;
  inputDigest: string;
  outputDigest: string;
  loop: number;
}): string {
  return JSON.stringify([
    loop.tool,
    loop.inputDigest,
    loop.outputDigest,
    loop.loop,
  ]);
}

/**
 * The workspace's limit. No policy row means the team has not set one, so
 * the default applies. A row with no count means the team cleared it, so no
 * check runs.
 */
export async function readNoProgressLimit(
  scope: NoProgressScope,
): Promise<NoProgressLimit | null> {
  // tenancy: the scheduled no-progress check runs outside a tenant scope, so
  // the read is filtered by the run's orgId and workspaceId.
  const rows = await withSystemDb((tx) =>
    tx
      .select({ repeats: policy.repeats, mode: policy.mode })
      .from(policy)
      .where(
        and(
          eq(policy.orgId, scope.orgId),
          eq(policy.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1),
  );
  return limitOfPolicy(rows[0]);
}

/** {@link readNoProgressLimit}'s rule over the row it read, if any. */
export function limitOfPolicy(
  row: { repeats: number | null; mode: string } | undefined,
): NoProgressLimit | null {
  if (row === undefined) return { ...NO_PROGRESS_DEFAULT_LIMIT };
  return noProgressLimitOf(row);
}

/** The loops the run already has a row for, by {@link loopKeyOf}. */
export async function readRecordedLoops(
  run: NoProgressRun,
): Promise<Set<string>> {
  // tenancy: the scheduled no-progress check runs outside a tenant scope, so
  // the read is filtered by the run's orgId, workspaceId, and run id.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        tool: hits.tool,
        inputDigest: hits.inputDigest,
        outputDigest: hits.outputDigest,
        loop: hits.loop,
      })
      .from(hits)
      .where(
        and(
          eq(hits.orgId, run.orgId),
          eq(hits.workspaceId, run.workspaceId),
          eq(hits.runId, run.runId),
        ),
      ),
  );
  return new Set(rows.map(loopKeyOf));
}

/**
 * Insert each loop's row, or raise the count on the row it already has. The
 * mode, outcome, pause block, limit, and call that reached it stay as first
 * recorded.
 */
export async function writeNoProgressHits(
  run: NoProgressRun,
  rows: readonly NoProgressHit[],
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  // tenancy: the scheduled no-progress check runs outside a tenant scope; every
  // row carries the orgId and workspaceId the run's own record answered.
  await withSystemDb((tx) =>
    tx
      .insert(hits)
      .values(
        rows.map((r) => ({
          orgId: run.orgId,
          workspaceId: run.workspaceId,
          runId: run.runId,
          tool: r.tool,
          inputDigest: r.inputDigest,
          outputDigest: r.outputDigest,
          loop: r.loop,
          repeats: r.repeats,
          limitRepeats: r.limitRepeats,
          atCall: r.atCall,
          mode: r.mode,
          outcome: r.outcome,
          pauseBlock: r.pauseBlock,
          detectedAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          hits.workspaceId,
          hits.runId,
          hits.tool,
          hits.inputDigest,
          hits.outputDigest,
          hits.loop,
        ],
        set: {
          repeats: sql`greatest(${hits.repeats}, excluded.repeats)`,
          updatedAt: now,
        },
      }),
  );
}

/**
 * A ledger call's write flag from its capability's declaration, where the
 * ledger frame carries none (#4503). A ledger run's tool calls are
 * capability calls, and the registry says whether each one writes. A call
 * the registry does not know keeps its null flag, which the check treats as
 * a call that may write.
 */
export function withDeclaredMutation(call: ToolCallFrame): ToolCallFrame {
  if (call.isMutating !== null || call.name === null) return call;
  const capability = getCapability(call.name);
  if (capability === undefined) return call;
  return { ...call, isMutating: capabilityMutates(capability) };
}

/**
 * The run's tool calls and file changes in the order they ran. A wrapped
 * run's harness announces file changes as frames of their own. A ledger
 * run's agent changes files only through its own tool calls, so its tool
 * calls are all the check needs, each with the write flag its capability
 * declares.
 */
export async function readNoProgressFrames(
  source: RunSource,
): Promise<NoProgressFrame[]> {
  if (source.frames.kind === "ledger")
    return (await readRunToolCalls(source)).map(withDeclaredMutation);
  return readTachoProgressFrames({
    orgId: source.meta.orgId,
    workspaceId: source.meta.workspaceId,
    rootSessionUuid: source.frames.rootSessionUuid,
    sessionUuids: source.frames.sessionUuids,
  });
}

const productionDeps: NoProgressDeps = {
  now: () => new Date(),
  readLimit: readNoProgressLimit,
  loadRunSource,
  readFrames: readNoProgressFrames,
  readRecorded: readRecordedLoops,
  writeHits: writeNoProgressHits,
  // The pause path lives in @oxagen/handlers, which this package cannot
  // import. `cost.run-progress` passes the one `@oxagen/handlers/register`
  // installs through `no-progress-pause-runner.ts`.
  pauseRun: null,
};

/**
 * Ask the pause path to pause the run for the loops this check found first.
 * A sealed run and a process with no pause path answer their block without
 * asking.
 */
async function pauseFor(
  run: NoProgressRun,
  loops: readonly NoProgressLoop[],
  limit: NoProgressLimit,
  pauseRun: PauseRun | null,
): Promise<NoProgressPauseOutcome> {
  if (run.sealed) return { paused: false, block: "run_sealed" };
  if (pauseRun === null) return { paused: false, block: "pause_unavailable" };
  return pauseRun({
    ...run,
    loops: loops.map((l) => ({ ...l, key: pauseKeyOf(l) })),
    limit,
  });
}

/**
 * Check one run against its workspace's no-progress limit and record each
 * loop that reached it. A workspace that cleared its limit reads no calls.
 * An enforced limit pauses the run once for the loops this check found
 * first, and records why when it could not.
 *
 * The pause comes before the write, and the pause path is idempotent by loop
 * key. A write that fails after the pause was queued leaves the loop
 * unrecorded, so the retry asks again for the same loop, finds the pause it
 * queued, queues nothing, and records `paused` (#4503).
 *
 * `overrides` replaces the production reads and writes it names. The job
 * passes the installed `pauseRun`, and tests pass the rest.
 */
export async function checkNoProgress(
  run: NoProgressRun,
  overrides: Partial<NoProgressDeps> = {},
): Promise<NoProgressCheck> {
  const deps: NoProgressDeps = { ...productionDeps, ...overrides };
  const limit = await deps.readLimit(run);
  if (limit === null) return UNCHECKED;
  const source = await deps.loadRunSource(run.runId);
  if (
    source === null ||
    source.meta.orgId !== run.orgId ||
    source.meta.workspaceId !== run.workspaceId
  )
    return UNCHECKED;

  const loops = findNoProgressLoops(
    await deps.readFrames(source),
    limit.repeats,
  );
  if (loops.length === 0) return { ...UNCHECKED, checked: true };

  const recorded = await deps.readRecorded(run);
  const newLoops = loops.filter((l) => !recorded.has(loopKeyOf(l)));
  const pause =
    limit.mode === "enforced" && newLoops.length > 0
      ? await pauseFor(run, newLoops, limit, deps.pauseRun)
      : null;
  const paused = pause?.paused === true;

  const outcome = noProgressOutcome(limit.mode, paused);
  const pauseBlock = pause !== null && !pause.paused ? pause.block : null;
  await deps.writeHits(
    run,
    loops.map((l) => ({
      ...l,
      limitRepeats: limit.repeats,
      mode: limit.mode,
      outcome,
      pauseBlock,
    })),
    deps.now(),
  );
  return {
    checked: true,
    loops: loops.length,
    newLoops: newLoops.length,
    paused,
  };
}
