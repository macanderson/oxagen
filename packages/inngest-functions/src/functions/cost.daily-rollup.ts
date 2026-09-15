import {
  listRunsAwaitingRollup,
  listWorkspacesWithRuns,
  rebuildDailyTotals,
  rebuildRunTotals,
  utcDay,
} from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** Runs the sweep rolls up per night; a seal whose event was lost waits at most a night per batch. */
const SWEEP_BATCH = 500;

/**
 * Nightly at 01:00 UTC: roll up every sealed run whose `cost.run_totals` row
 * is missing or older than its seal (a `cost/run.sealed` event that was lost
 * or failed its retries), then rebuild yesterday's `cost.daily_totals` for
 * every workspace that started a run that day (Mission Control spec §12.3,
 * §12.7; ADR-060 §3). Idempotent: both rebuilds replace what they find.
 */
export const [costDailyRollup] = createFunction(
  { id: "cost.daily-rollup", retries: 3 },
  { cron: "0 1 * * *" },
  async ({ step }) => {
    const pending = await step.run("list-pending-runs", () =>
      listRunsAwaitingRollup({ limit: SWEEP_BATCH }),
    );
    let rolledUp = 0;
    for (const runId of pending) {
      const ok = await step.run(`run-${runId}`, async () => {
        try {
          const record = await rebuildRunTotals(runId);
          return record !== null;
        } catch (err) {
          // One run's degraded frame read must not stop the sweep; the run
          // stays pending and the next night retries it.
          logger.warn({ runId, err }, "cost.daily-rollup: run rollup failed");
          return false;
        }
      });
      if (ok) rolledUp += 1;
    }

    const yesterday = utcDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const workspaces = await step.run("list-workspaces", () =>
      listWorkspacesWithRuns({ day: yesterday }),
    );
    for (const ws of workspaces) {
      await step.run(`daily-${ws.workspaceId}`, () =>
        rebuildDailyTotals({ ...ws, day: yesterday }),
      );
    }
    logger.info(
      {
        pending: pending.length,
        rolledUp,
        day: yesterday,
        workspaces: workspaces.length,
      },
      "cost.daily-rollup complete",
    );
    return {
      pending: pending.length,
      rolledUp,
      day: yesterday,
      workspaces: workspaces.length,
    };
  },
);
