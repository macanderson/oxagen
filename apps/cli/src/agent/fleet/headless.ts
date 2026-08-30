/**
 * Headless fleet runner — the JSONL twin of the agents screen (`FleetApp`).
 *
 * Used by `oxagen agents --json` (and automatically whenever stdout isn't a
 * TTY, e.g. CI) so a fleet run is scriptable: the plan, every task's lifecycle
 * transitions, and any merge conflicts each stream as one JSON object per
 * line, ending in a machine-readable summary envelope. Mirrors the
 * TTY/headless split in `tui/best-of-n-view/index.tsx`, but kept in `agent/
 * fleet/` (framework-free, no Ink) rather than `tui/` so it's unit-testable
 * with a fake runner exactly like {@link Fleet}'s own tests.
 *
 * SIGINT/SIGTERM cancel-drain rather than kill: dispatch of new tasks stops,
 * but every in-flight agent finishes and its worktree is cleaned up normally
 * through {@link Fleet.drain} — a cancelled CI job never leaves an orphan
 * worktree behind.
 */
import type { Fleet, FleetTaskEvent } from "./orchestrator.js";
import type { IntegrationResult } from "./git-isolation.js";
import type { FleetSnapshot, Plan } from "./types.js";

export interface FleetHeadlessOptions {
  fleet: Fleet;
  /** Produce + persist the plan; omit to run a plan already loaded on `fleet`. */
  plan?: (signal: AbortSignal) => Promise<Plan>;
  /** Sink for each JSONL line; defaults to stdout. Injectable for tests. */
  write?: (line: string) => void;
}

/**
 * Run `fleet` headlessly, streaming JSONL to `write` (default `process.stdout`).
 * Resolves with the final snapshot once the run settles — either every task
 * reached a terminal state, or a SIGINT/SIGTERM drained it early.
 */
export async function runFleetHeadless(
  opts: FleetHeadlessOptions,
): Promise<FleetSnapshot> {
  const { fleet } = opts;
  const emit =
    opts.write ??
    ((line: string): void => void process.stdout.write(line + "\n"));

  // AgentSnapshot (used for the live TUI) doesn't carry `summary`/`agent` —
  // track each task's latest lifecycle event instead, so the final summary
  // envelope can report the same rich shape as the streamed "task" lines.
  const latest = new Map<string, FleetTaskEvent>();
  const onTask = (e: FleetTaskEvent): void => {
    latest.set(e.taskId, e);
    emit(JSON.stringify({ type: "task", ...e }));
  };
  const onConflict = (e: { taskId: string } & IntegrationResult): void =>
    emit(JSON.stringify({ type: "conflict", ...e }));
  fleet.on("task", onTask);
  fleet.on("conflict", onConflict);

  // A second signal is a no-op: drain() is idempotent, and there is
  // deliberately no force-kill path here — an aborted mid-edit worktree can
  // lose uncommitted work, which is exactly what cancel-drain exists to avoid.
  const planAbort = new AbortController();
  const onSignal = (): void => {
    emit(JSON.stringify({ type: "draining" }));
    planAbort.abort();
    void fleet.drain();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let planned: Plan | null = null;
  try {
    if (opts.plan) {
      planned = await opts.plan(planAbort.signal);
      emit(
        JSON.stringify({
          type: "plan",
          planId: planned.id,
          goal: planned.goal,
          tasks: planned.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            dependsOn: t.dependsOn,
            files: t.files,
            tier: t.tier,
          })),
        }),
      );
      fleet.loadPlan(planned);
    }
    await fleet.start();
  } finally {
    fleet.off("task", onTask);
    fleet.off("conflict", onConflict);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const snap = fleet.snapshot();
  emit(
    JSON.stringify({
      type: "summary",
      planId: planned?.id ?? null,
      goal: planned?.goal ?? null,
      queuedCount: snap.queuedCount,
      runningCount: snap.runningCount,
      doneCount: snap.doneCount,
      failedCount: snap.failedCount,
      totals: snap.totals,
      tasks: [...latest.values()],
    }),
  );
  return snap;
}
