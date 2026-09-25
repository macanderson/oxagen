// steering-sync-runner.ts: the seam between the durable steering sync
// (functions/steering.sync.ts) and the code that performs it (ADR-184).
//
// The sync reads the main repository and writes the context registry through
// `@oxagen/handlers`, and `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers' register module installs the runner
// when the API process boots, before the Inngest route can invoke a function.

export interface SteeringSyncScope {
  orgId: string;
  workspaceId: string;
}

export interface SteeringSyncResult {
  outcome: string;
  headSha: string | null;
  /** Seconds to wait before syncing again, or null. */
  retryAfterSeconds: number | null;
}

export type SteeringSyncRunner = (
  scope: SteeringSyncScope,
  options: { force: boolean },
) => Promise<SteeringSyncResult>;

let runner: SteeringSyncRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setSteeringSyncRunner(next: SteeringSyncRunner): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function steeringSyncRunner(): SteeringSyncRunner {
  if (!runner)
    throw new Error(
      "[steering.sync] no sync runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
