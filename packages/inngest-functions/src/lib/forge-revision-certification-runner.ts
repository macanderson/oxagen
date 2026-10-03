// forge-revision-certification-runner.ts: the seam between the durable
// certification request (functions/forge.revision-certification.ts) and the
// code that performs it (ADR-294).
//
// Both steps read and write `forge.revision_certifications` in
// `@oxagen/handlers`. `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers' register module installs the
// runner when the API process boots, before the Inngest route can invoke a
// function. `forge-pull-request-sync-runner.ts` is the same seam for the
// same reason.

import type { ForgePullRequestDiffReadyEventData } from "../events";

/**
 * The data of `forge/pull-request-diff.ready`, as the sync sends it once per
 * stored revision.
 */
export type ForgeRevisionCertificationRequest = ForgePullRequestDiffReadyEventData;

/** Where a stored revision stands with the witness. */
export type ForgeCertificationState = "pending" | "certified" | "rejected";

/** What the queue step did, for the function's step output. */
export interface ForgeCertificationQueueOutcome {
  /**
   * `queued`: this delivery wrote the pending row. `existing`: an earlier
   * delivery wrote it. `gone`: the scope holds no such revision on that pull
   * request, because it was deleted since the event was sent.
   */
  outcome: "queued" | "existing" | "gone";
  /** The row's public id; null when the revision is gone. */
  certificationId: string | null;
  /** The row's state; null when the revision is gone. */
  state: ForgeCertificationState | null;
}

/** What the certify step did, for the function's step output. */
export interface ForgeCertificationOutcome {
  /** The row's state after the step. It stays `pending` until the witness exists. */
  state: ForgeCertificationState;
  /** Why the row is still pending, such as `witness_not_built`; null once decided. */
  reason: string | null;
}

export interface ForgeRevisionCertificationRunner {
  /** Write the revision's pending row, once however often the event arrives. */
  queue(
    request: ForgeRevisionCertificationRequest,
  ): Promise<ForgeCertificationQueueOutcome>;
  /**
   * Ask the witness for a verdict on one pending row. This is where the
   * witness plugs in (ADR-064). Until it exists, the row stays pending.
   */
  certify(
    request: ForgeRevisionCertificationRequest,
    certificationId: string,
  ): Promise<ForgeCertificationOutcome>;
}

let runner: ForgeRevisionCertificationRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setForgeRevisionCertificationRunner(
  next: ForgeRevisionCertificationRunner,
): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function forgeRevisionCertificationRunner(): ForgeRevisionCertificationRunner {
  if (!runner)
    throw new Error(
      "[forge.revision-certification] no certification runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
