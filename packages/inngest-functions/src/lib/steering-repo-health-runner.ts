// steering-repo-health-runner.ts: the seam between the durable jobs that read
// a steering repo's health (functions/steering-repo.sweep.ts) and the code
// that reads the host and acts on the result (lane S2, #4560).
//
// The health read lives in `@oxagen/handlers`, which depends on this package,
// so this package cannot import it. The handlers' register module installs the
// runner when the API process boots, before the Inngest route can invoke a
// function.

/** Whose steering repo the job reads. */
export interface SteeringRepoHealthScope {
  orgId: string;
  /** Null for the organization repository `<org>/oxagen`. */
  workspaceId: string | null;
}

/** What asked for the read, and what the event says about the change. */
export interface SteeringRepoHealthTrigger {
  /** Such as `repository_ruleset.deleted`, `push`, `pull_request.opened`, or `sweep`. */
  reason: string;
  /** The login the event names as the actor, or null. */
  actor: string | null;
  /** When the event says the change happened, as ISO 8601, or null. */
  at: string | null;
  /** Setting paths the event touched. Empty when the event names none. */
  settings: readonly string[];
  /** The pull request that opened or changed, or null. */
  pull_request: { number: number; head_sha: string } | null;
}

/** One `steering-repo/health.requested` event. */
export interface SteeringRepoHealthRequest {
  name: "steering-repo/health.requested";
  data: {
    orgId: string;
    workspaceId: string | null;
    /** One read at a time per repo: `<orgId>:<workspaceId or "org">`. */
    key: string;
    trigger: SteeringRepoHealthTrigger;
  };
}

export interface SteeringRepoHealthRunner {
  /** One health request per ready steering repo, for the 10-minute sweep. */
  sweepRequests(): Promise<SteeringRepoHealthRequest[]>;
  /** Read one steering repo's health and act on it. Null when the scope has no ready steering repo. A rate limit throws so the job retries. */
  check(
    scope: SteeringRepoHealthScope,
    trigger: SteeringRepoHealthTrigger,
  ): Promise<{ health: string } | null>;
}

let runner: SteeringRepoHealthRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setSteeringRepoHealthRunner(next: SteeringRepoHealthRunner): void {
  runner = next;
}

/** The installed runner. It throws in a process that booted without handlers. */
export function steeringRepoHealthRunner(): SteeringRepoHealthRunner {
  if (!runner)
    throw new Error(
      "[steering-repo.health] no health runner is installed. Import @oxagen/handlers/register before serving Inngest functions.",
    );
  return runner;
}
