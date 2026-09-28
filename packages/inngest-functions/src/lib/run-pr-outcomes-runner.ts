// run-pr-outcomes-runner.ts: the seam between the hourly outcome refresh
// (functions/cost.run-pr-outcomes.ts) and the code that performs it (#4491).
//
// The refresh reads pull requests, their checks, and their branches from
// GitHub through `@oxagen/handlers`, and `@oxagen/handlers` depends on this
// package, so this package cannot import it. The handlers' register module
// installs the runner when the API process boots, before the Inngest route
// can invoke a function. `run-pull-request-backfill-runner.ts` is the same
// seam for the same reason.

/** The workspace one refresh pass visits. */
export interface RunPrOutcomesRequest {
  orgId: string;
  workspaceId: string;
}

/** What one pass did, for the function's step output. */
export interface RunPrOutcomesResult {
  /** Sealed runs in the window. */
  runs: number;
  /** Pull requests read from GitHub this pass. */
  forgeReads: number;
  /** Pull requests left for the next pass by the per-pass read cap. */
  deferred: number;
  /** Rows written. */
  rows: number;
  /** Rows this pass marked reverted, from the reverts kept in `cost.run_pr_reverts`. */
  reverted: number;
}

export type RunPrOutcomesRunner = (
  request: RunPrOutcomesRequest,
) => Promise<RunPrOutcomesResult>;

let runner: RunPrOutcomesRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setRunPrOutcomesRunner(next: RunPrOutcomesRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function runPrOutcomesRunner(): RunPrOutcomesRunner {
  if (!runner)
    throw new Error(
      "[cost.run-pr-outcomes] no outcome runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
