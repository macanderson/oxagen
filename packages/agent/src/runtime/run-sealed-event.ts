/**
 * `cost/run.sealed` for an in-app assistant run (#4167).
 *
 * Every other seal sends this event once its seal commits: tacho ingest on a
 * host's `agent_stop`, `seal_run` on an operator's seal, and the idle close.
 * The cost rollup (`cost.run-rollup`) builds the run's `cost.run_totals` row
 * on it. An assistant turn sealed its run and sent nothing, so its row waited
 * for the nightly sweep, and the flyout's cost line read "pending" for up to
 * a day.
 *
 * The event client lives in `@oxagen/inngest-functions`, which depends on this
 * package, so this package cannot import it. The surface hands the sender in
 * once at boot, the way it installs the kernel's gates:
 * `@oxagen/handlers/register`, which every surface that runs a turn loads
 * (the app's kernel seam, the API, the MCP server), calls
 * `setRunSealedSender`.
 *
 * Sending is best-effort, as it is on the other seal paths. The seal has
 * committed by then, and the nightly sweep rolls up a sealed run whose event
 * was lost, so a failed send is logged and never fails the turn.
 */
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.run-sealed-event" },
});

/** The event the cost rollup rebuilds a sealed run's totals on. */
export type RunSealedEvent = {
  name: "cost/run.sealed";
  data: { runId: string; orgId: string; workspaceId: string };
};

export type RunSealedSender = (event: RunSealedEvent) => Promise<void>;

let sender: RunSealedSender | null = null;

/** Install the sender at surface boot; null removes it (tests). */
export function setRunSealedSender(next: RunSealedSender | null): void {
  sender = next;
}

/**
 * Send `cost/run.sealed` for a run whose seal has committed. Never throws: a
 * missing sender or a failed send is logged, and the nightly sweep rolls the
 * run up.
 */
export async function sendRunSealed(event: RunSealedEvent): Promise<void> {
  if (sender === null) {
    logger.warn(
      { runId: event.data.runId },
      "no run-sealed sender is installed; the nightly sweep rolls the run up",
    );
    return;
  }
  try {
    await sender(event);
  } catch (err) {
    logger.error(
      { err, runId: event.data.runId },
      "cost/run.sealed dispatch failed; the nightly sweep rolls the run up",
    );
  }
}
