// steering-repo-provision-runner.ts: the seam between the durable job that
// provisions a steering repo (functions/steering-repo.provision.ts) and the
// code that performs each step (lane S1, #4450).
//
// The steps live in `@oxagen/handlers`, which depends on this package, so this
// package cannot import them. The handlers' register module installs the
// runner when the API process boots, before the Inngest route can invoke a
// function.

/** Whose steering repo the job provisions. */
export interface SteeringRepoProvisionScope {
  orgId: string;
  /** Null for the organization repository `<org>/oxagen`. */
  workspaceId: string | null;
  /** The person who created the workspace or the organization. */
  actorUserId: string;
}

export interface SteeringRepoStepResult {
  step: string;
  /** provisioning, ready, failed, or blocked. */
  status: string;
  /** False when the step does not apply to this scope or provider. */
  ran: boolean;
}

export interface SteeringRepoProvisionRunner {
  /**
   * The steps, in the order the job runs them. The list is fixed, and it is
   * async so the install does not load the steps' code at boot.
   */
  steps(): Promise<readonly string[]>;
  /**
   * Run one step. It throws an error flagged `isNonRetriable` when a retry
   * cannot help, such as a missing authorization or a taken name.
   */
  runStep(
    scope: SteeringRepoProvisionScope,
    step: string,
  ): Promise<SteeringRepoStepResult>;
}

let runner: SteeringRepoProvisionRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setSteeringRepoProvisionRunner(
  next: SteeringRepoProvisionRunner,
): void {
  runner = next;
}

/** The installed runner. It throws in a process that booted without handlers. */
export function steeringRepoProvisionRunner(): SteeringRepoProvisionRunner {
  if (!runner)
    throw new Error(
      "[steering-repo.provision] no provision runner is installed. Import @oxagen/handlers/register before serving Inngest functions.",
    );
  return runner;
}
