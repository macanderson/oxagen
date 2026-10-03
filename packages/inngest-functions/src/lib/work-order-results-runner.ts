// work-order-results-runner.ts: the seam between the durable work order
// result functions (functions/work.order-results.ts) and the code that
// records them (ADR-251).
//
// Recording a run's end or a pull request on a work order, and the hourly
// sweep that records what a lost event left out (lib/work-records/sweep.ts in
// `@oxagen/handlers`), write work records and read GitHub through
// `@oxagen/handlers`, and `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers'
// register module installs the runner when the API process boots, before the
// Inngest route can invoke a function, as `run-pull-request-backfill-runner`
// does.

/** A run that sealed. */
export interface WorkRunEndedRequest {
  orgId: string;
  workspaceId: string;
  /** The run's public id (`tse_…` or `arun_…`). */
  runId: string;
}

/** A pull request a run named. */
export interface WorkPullRequestLinkedRequest {
  orgId: string;
  workspaceId: string;
  /** The root session's `session_uuid`, as the frames carry it. */
  rootSessionUuid: string;
  /** The pull request's https URL as the frame recorded it. */
  url: string;
}

/** A workspace the hourly sweep visits. */
export interface WorkOrderSweepScope {
  orgId: string;
  workspaceId: string;
}

/** What one workspace's sweep recorded. Counts only, so a step's output stays JSON. */
export interface WorkOrderSweepResult {
  /** Sends that recorded the end of a run whose seal event was lost. */
  sendsEnded: number;
  /** Sends whose pull request was read again. */
  sendsRead: number;
  /** Facts those reads recorded. */
  factsRecorded: number;
  /** Runs and sends the pass could not record. The next pass tries them again. */
  failed: number;
}

export interface WorkOrderResultsRunner {
  /** Record the run's end on the sends it is linked to. Returns how many recorded it. */
  runEnded(request: WorkRunEndedRequest): Promise<number>;
  /** Record the pull request on the sends linked to the run, and read its evidence. Returns the facts recorded. */
  pullRequestLinked(request: WorkPullRequestLinkedRequest): Promise<number>;
  /** The workspaces with an open send that a run linked. */
  sweepScopes(): Promise<WorkOrderSweepScope[]>;
  /**
   * Record what a lost event left out of one workspace's open sends: the end
   * of a run that sealed, and a merge or close of a send's pull request.
   */
  sweep(scope: WorkOrderSweepScope): Promise<WorkOrderSweepResult>;
}

let runner: WorkOrderResultsRunner | null = null;

/** Install the runner, or remove it with null. `@oxagen/handlers/register` calls this at boot. */
export function setWorkOrderResultsRunner(next: WorkOrderResultsRunner | null): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function workOrderResultsRunner(): WorkOrderResultsRunner {
  if (!runner) {
    throw new Error(
      "[work.order-results] no work order results runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  }
  return runner;
}
