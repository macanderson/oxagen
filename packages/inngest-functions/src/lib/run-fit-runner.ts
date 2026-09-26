// run-fit-runner.ts: the seam between the durable Model fit job
// (functions/run.fit.ts) and the code that computes the reading (#3893,
// ADR-194).
//
// The reading reads the run the way the Run page does: the `list_runs` row,
// `get_run`'s effort, and `get_run_transcript`'s figures. All three live in
// `@oxagen/handlers`, which depends on this package, so this package cannot
// import them. The handlers' register module installs the runner when the API
// process boots, before the Inngest route can invoke a function, as it does
// for the steering sync (ADR-184).

export interface RunFitScope {
  orgId: string;
  workspaceId: string;
}

/** What one reading did: `written`, or why nothing was written. */
export type RunFitRunnerOutcome = "written" | "live" | "not_found";

export type RunFitRunner = (
  scope: RunFitScope,
  runPublicId: string,
) => Promise<RunFitRunnerOutcome>;

let runner: RunFitRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setRunFitRunner(next: RunFitRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function runFitRunner(): RunFitRunner {
  if (!runner)
    throw new Error(
      "[run.fit] no fit runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
