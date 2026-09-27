// memory-runner.ts: the seam between the durable memory jobs
// (functions/run.reflect.ts and functions/memory.curate.ts) and the code that
// captures, curates, and settles memories (ADR-206).
//
// Capture reads the run the way the Run page does, and the curator writes the
// steering repo through the steering host. Both live in `@oxagen/handlers`,
// which depends on this package, so this package cannot import them. The
// handlers' register module installs the runner when the API process boots,
// before the Inngest route can invoke a function, as it does for the Model fit
// reading.

export interface MemoryRunnerScope {
  orgId: string;
  workspaceId: string;
}

/** What capture found in one sealed run. */
export interface MemoryCaptureOutcome {
  /** `captured`, or why the run was not read. */
  outcome: "captured" | "not_found" | "live";
  /** Memories written. A retried capture writes none twice. */
  memories: number;
  /** True when the run holds the agent's own reflection. */
  reflected: boolean;
  /** True when the run needs a digest reflection: it shows a signal and holds no reflection. */
  digest: boolean;
  /** Memories waiting in the workspace after this capture. */
  waiting: number;
}

/** What the digest reflection step did. */
export type MemoryDigestOutcome =
  | "written"
  | "exists"
  | "no_signal"
  | "disabled"
  | "not_found";

/** What one curate pass did in one workspace. */
export interface MemoryCurateOutcome {
  /** `curated`, or why the pass stopped before planning. */
  outcome:
    | "curated"
    | "idle"
    | "no_repository"
    | "no_governance"
    | "opened_today";
  settled: number;
  dropped: number;
  /** The memory PR the pass opened, or null. */
  pullRequest: { number: number; url: string } | null;
}

export interface MemoryRunner {
  /** Store the memories and the reflection a sealed run recorded. */
  capture(
    scope: MemoryRunnerScope,
    runPublicId: string,
  ): Promise<MemoryCaptureOutcome>;
  /** Write a reflection from the run's digest on the fast tier. */
  digest(
    scope: MemoryRunnerScope,
    runPublicId: string,
  ): Promise<MemoryDigestOutcome>;
  /** Settle open memory PRs and open the day's memory PR. */
  curate(scope: MemoryRunnerScope, now: Date): Promise<MemoryCurateOutcome>;
  /** Every workspace with waiting memories, an open memory PR, or a recall row. */
  workspaces(): Promise<MemoryRunnerScope[]>;
}

/** Waiting memories that start a curate pass before the daily one. */
export const MEMORY_CURATE_WAITING = 20;

let runner: MemoryRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setMemoryRunner(next: MemoryRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function memoryRunner(): MemoryRunner {
  if (!runner)
    throw new Error(
      "[memory] no memory runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
