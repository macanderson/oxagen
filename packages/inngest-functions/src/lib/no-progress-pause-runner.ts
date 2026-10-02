// no-progress-pause-runner.ts: the seam between the no-progress check
// (functions/cost.run-progress.ts, `checkNoProgress` in @oxagen/billing) and
// the code that pauses a run (spend spec, detector 1; #4490).
//
// An enforced limit pauses the run the way an operator's pause does: it
// queues a `pause` command on `tacho.control_commands` for the run's host,
// and the host refuses the agent's next governed call while the pause holds.
// The command store and the rule that says whether a run can take a command
// (`commandBlockOf`) live in `@oxagen/handlers`, which depends on this
// package, so this package cannot import them. The handlers' register module
// installs the runner when the API process boots, before the Inngest route
// can invoke a function, as it does for the interjection timeout
// (interjection-timeout-runner.ts).
//
// Unlike that seam, a process with no runner installed does not throw. The
// check records the hit with `pause_unavailable` instead, so a missing pause
// path never holds back the record of the loop.

import type { PauseRun } from "@oxagen/billing";

export interface NoProgressPauseRunner {
  /** Queue a pause for the run, once per loop key. */
  pause: PauseRun;
}

let runner: NoProgressPauseRunner | null = null;

/** Install the runner. `@oxagen/handlers/register` calls this at boot. */
export function setNoProgressPauseRunner(next: NoProgressPauseRunner): void {
  runner = next;
}

/** The installed pause path, or null in a process that booted without handlers. */
export function noProgressPauseRun(): PauseRun | null {
  const installed = runner;
  return installed === null ? null : (request) => installed.pause(request);
}
