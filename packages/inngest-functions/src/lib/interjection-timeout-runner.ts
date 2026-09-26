// interjection-timeout-runner.ts: the seam between the durable interjection
// timeout (functions/agent.interjection-timeout.ts) and the code that
// performs it (#3941, D8).
//
// Both steps read and write `agent.interjections`, read GitHub, queue a
// command through the tacho command store and write a security event, all
// in `@oxagen/handlers`. `@oxagen/handlers` depends on this package, so this
// package cannot import it. The handlers' register module installs the
// runner when the API process boots, before the Inngest route can invoke a
// function. `run-pull-request-backfill-runner.ts` is the same seam for the
// same reason.

import type { AgentInterjectionRaisedEventData } from "../events";

/** What the repository step did, for the function's step output. */
export interface InterjectionResolveOutcome {
  /**
   * `resolved`: the repository was written onto the row. `unresolved`: the
   * workspace's installation reaches no match, or GitHub failed. `skipped`:
   * the row already names one, is answered, or is gone.
   */
  outcome: "resolved" | "unresolved" | "skipped";
  repository: string | null;
}

/** What the deny step did, for the function's step output. */
export interface InterjectionDenyOutcome {
  /**
   * `denied`: nobody had answered, and the timeout answered deny.
   * `receipted`: the host's own timeout had answered deny, and the timeout
   * added the receipt and the audit event. `answered`: a person answered
   * first, or an earlier run of this step already denied. `not_due`: the
   * deadline has not passed. `gone`: no such row in the scope.
   */
  outcome: "denied" | "receipted" | "answered" | "not_due" | "gone";
  receiptId: string | null;
  commandIds: string[];
}

export interface InterjectionTimeoutRunner {
  /** Name the repository the host asked about, so the Run page can show it. */
  resolve(
    request: AgentInterjectionRaisedEventData,
  ): Promise<InterjectionResolveOutcome>;
  /** Answer `deny` with source `timeout`, when nobody answered in time. */
  deny(request: AgentInterjectionRaisedEventData): Promise<InterjectionDenyOutcome>;
}

let runner: InterjectionTimeoutRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setInterjectionTimeoutRunner(
  next: InterjectionTimeoutRunner,
): void {
  runner = next;
}

/** The installed runner; throws in a process that booted without handlers. */
export function interjectionTimeoutRunner(): InterjectionTimeoutRunner {
  if (!runner)
    throw new Error(
      "[agent.interjection-timeout] no timeout runner is installed; import @oxagen/handlers/register before serving Inngest functions",
    );
  return runner;
}
