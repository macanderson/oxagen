// run-pull-request-backfill-runner.ts: the seam between the durable backfill
// (functions/run.pull-request-backfill.ts) and the code that performs it
// (ADR-189).
//
// The backfill writes `tacho.run_pull_requests` and reads GitHub and GitLab
// through `@oxagen/handlers`, and `@oxagen/handlers` depends on this package,
// so this package cannot import it. The handlers' register module installs the
// runner when the API process boots, before the Inngest route can invoke a
// function. `steering-sync-runner.ts` is the same seam for the same reason.

/** One recorded link: the root session that named it, and the URL. */
export interface PullRequestBackfillRequest {
  orgId: string;
  workspaceId: string;
  /** The root session's `session_uuid`, as the frames carry it. */
  rootSessionUuid: string;
  /** The https URL as the frame recorded it. */
  url: string;
}

/** What the runner did, for the function's step output. */
export interface PullRequestBackfillOutcome {
  outcome: string;
  rows: number;
}

export type PullRequestBackfillRunner = (
  request: PullRequestBackfillRequest,
) => Promise<PullRequestBackfillOutcome>;

let runner: PullRequestBackfillRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setPullRequestBackfillRunner(
  next: PullRequestBackfillRunner,
): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function pullRequestBackfillRunner(): PullRequestBackfillRunner {
  if (!runner)
    throw new Error(
      "[run.pull-request-backfill] no backfill runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
