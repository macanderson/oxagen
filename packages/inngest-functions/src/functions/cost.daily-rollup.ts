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

type WorkspaceDay = { orgId: string; workspaceId: string; day: string };

/**
 * Nightly at 01:00 UTC: roll up every sealed run whose `cost.run_totals` row
 * is missing or older than its seal (a `cost/run.sealed` event that was lost
 * or failed its retries), then rebuild `cost.daily_totals` for yesterday in
 * every workspace that started a run that day and for the workspace-day of
 * every run the sweep rolled up (Mission Control spec §12.3, §12.7; ADR-060
 * §3). Idempotent: both rebuilds replace what they find.
 */
export const [costDailyRollup] = createFunction(
  { id: "cost.daily-rollup", retries: 3 },
  { cron: "0 1 * * *" },
  async ({ step }) => {
    const pending = await step.run("list-pending-runs", () =>
      listRunsAwaitingRollup({ limit: SWEEP_BATCH }),
    );
    // Every workspace-day a rolled-up run started on is refolded along with
    // yesterday: a run that started earlier than yesterday, or waited in a
    // backlog, reaches its day row through the same sweep as its run row.
    const days = new Map<string, WorkspaceDay>();
    let rolledUp = 0;
    for (const runId of pending) {
      const day = await step.run(
        `run-${runId}`,
        async (): Promise<WorkspaceDay | null> => {
          try {
            const record = await rebuildRunTotals(runId);
            if (!record) return null;
            return {
              orgId: record.orgId,
              workspaceId: record.workspaceId,
              day: utcDay(record.startedAt),
            };
          } catch (err) {
            // One run's degraded frame read must not stop the sweep; the run
            // stays pending and the next night retries it.
            logger.warn({ runId, err }, "cost.daily-rollup: run rollup failed");
            return null;
          }
        },
      );
      if (day) {
        rolledUp += 1;
        days.set(`${day.workspaceId}:${day.day}`, day);
      }
    }

    const yesterday = utcDay(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const workspaces = await step.run("list-workspaces", () =>
      listWorkspacesWithRuns({ day: yesterday }),
    );
    for (const ws of workspaces)
      days.set(`${ws.workspaceId}:${yesterday}`, { ...ws, day: yesterday });
    for (const target of days.values()) {
      await step.run(`daily-${target.workspaceId}-${target.day}`, () =>
        rebuildDailyTotals(target),
      );
    }
    logger.info(
      {
        pending: pending.length,
        rolledUp,
        day: yesterday,
        workspaceDays: days.size,
      },
      "cost.daily-rollup complete",
    );
    return {
      pending: pending.length,
      rolledUp,
      day: yesterday,
      workspaceDays: days.size,
    };
  },
);
