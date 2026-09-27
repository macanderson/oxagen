/**
 * no-progress-store.ts — the reads and writes around the no-progress limit
 * (./no-progress.ts; spend spec, detector 1; #4490): the workspace's limit
 * from `workspace.no_progress_policy`, the run's tool calls from the store
 * that holds the run, and one `cost.no_progress_hits` row per loop.
 *
 * `cost.run-progress` runs the check while a run is open. It reads the whole
 * run each pass, so every write here is idempotent: a loop keeps the row it
 * got when it reached the limit, and a later pass only raises `repeats` as
 * the loop grows. The mode and outcome stay as they were at that first pass.
 *
 * Everything runs on the system connection with explicit org and workspace
 * predicates, since the job runs outside a tenant scope.
 */
import { schema, withSystemDb } from "@oxagen/database";
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
  type NoProgressLimit,
  type NoProgressLoop,
  type NoProgressMode,
  type NoProgressOutcome,
} from "./no-progress";

const policy = schema.noProgressPolicy;
const hits = schema.noProgressHits;

type NoProgressScope = { orgId: string; workspaceId: string };

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
}

/**
 * Pause a run at its next checkpoint, on governed calls. True when the pause
 * was queued.
 */
export type PauseRun = (run: NoProgressRun) => Promise<boolean>;

export interface NoProgressDeps {
  now: () => Date;
  readLimit: (scope: NoProgressScope) => Promise<NoProgressLimit | null>;
  loadRunSource: (runId: string) => Promise<RunSource | null>;
  readToolCalls: (source: RunSource) => Promise<ToolCallFrame[]>;
  /** The loops the run already has a row for, by {@link loopKeyOf}. */
  readRecorded: (run: NoProgressRun) => Promise<Set<string>>;
  writeHits: (
    run: NoProgressRun,
    rows: readonly NoProgressHit[],
    now: Date,
  ) => Promise<void>;
  /**
   * The pause path, or null when the check cannot reach it. With null, an
   * enforced limit records `would_pause`.
   */
  pauseRun: PauseRun | null;
}

/** What one check found. */
export interface NoProgressCheck {
  /** False when the workspace sets no limit, or no store has the run. */
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

/** The workspace's limit, or null when it sets none. */
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
  return noProgressLimitOf(rows[0]);
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
 * mode, outcome, limit, and call that reached it stay as first recorded.
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

const productionDeps: NoProgressDeps = {
  now: () => new Date(),
  readLimit: readNoProgressLimit,
  loadRunSource,
  readToolCalls: readRunToolCalls,
  readRecorded: readRecordedLoops,
  writeHits: writeNoProgressHits,
  // The pause path lives in @oxagen/handlers (`writeRecipientCommand`, the
  // write `pause_workspace_runs` makes), which this package cannot import.
  // Until a runner seam installs it, as `interjection-timeout-runner.ts`
  // does, an enforced limit records `would_pause` (#4490).
  pauseRun: null,
};

/**
 * Check one run against its workspace's no-progress limit and record each
 * loop that reached it. A workspace with no limit reads no calls. An
 * enforced limit pauses the run once for the loops this check found first,
 * and only while the run is open.
 */
export async function checkNoProgress(
  run: NoProgressRun,
  deps: NoProgressDeps = productionDeps,
): Promise<NoProgressCheck> {
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
    await deps.readToolCalls(source),
    limit.repeats,
  );
  if (loops.length === 0) return { ...UNCHECKED, checked: true };

  const recorded = await deps.readRecorded(run);
  const newLoops = loops.filter((l) => !recorded.has(loopKeyOf(l)));
  const paused =
    limit.mode === "enforced" &&
    newLoops.length > 0 &&
    !run.sealed &&
    deps.pauseRun !== null &&
    (await deps.pauseRun(run));

  const outcome = noProgressOutcome(limit.mode, paused);
  await deps.writeHits(
    run,
    loops.map((l) => ({
      ...l,
      limitRepeats: limit.repeats,
      mode: limit.mode,
      outcome,
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
