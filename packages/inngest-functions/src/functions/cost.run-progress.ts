import { rebuildDailyTotals, rebuildRunTotals, utcDay } from "@oxagen/billing";
import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { RUN_PROGRESSED_EVENT } from "../events";
import { logger } from "../logger";

/**
 * `cost/run.progressed` → rebuild a run's `cost.run_totals` row from the
 * frames recorded so far, then the daily groups of the workspace-day it
 * started on. On an open run the row keeps `sealed_at` null, which is what
 * every reader takes to mean the figure is an estimate: the run may still
 * add frames.
 *
 * Tacho ingest sends the event after each batch that landed model or tool
 * frames on a run it did not also seal (#3980), so a run's cost is visible
 * while it runs, not only after `cost/run.sealed`, and frames a subagent or a
 * resumed harness lands after the seal are counted as well. Frames arrive
 * every few seconds while an agent works, so the event is debounced per run:
 * the rollup runs 30 seconds after the latest batch, and at least every two
 * minutes while batches keep arriving.
 *
 * Concurrency is per workspace, not per run. Every run of a workspace-day
 * rebuilds the same `cost.daily_totals` rows, and one rebuild at a time per
 * workspace keeps a busy workspace's open runs from queueing a dozen
 * rewrites of the same day. The seal rollup can still land between two of
 * these, which is why the row write refuses to replace a sealed row with an
 * open one (`upsertRunTotals`).
 *
 * No findings pass: findings judge a finished run, and `cost.run-rollup`
 * requests one at the seal.
 */
export const [costRunProgress] = createFunction(
  {
    id: "cost.run-progress",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.workspaceId" },
    debounce: { key: "event.data.runId", period: "30s", timeout: "2m" },
  },
  { event: RUN_PROGRESSED_EVENT },
  async ({ event, step }) => {
    const { runId } = event.data as { runId: string };
    if (typeof runId !== "string" || runId.length === 0)
      throw new NonRetriableError(`${RUN_PROGRESSED_EVENT} carries no runId`);

    const run = await step.run("run-totals", async () => {
      const record = await rebuildRunTotals(runId);
      if (!record) return null;
      return {
        orgId: record.orgId,
        workspaceId: record.workspaceId,
        day: utcDay(record.startedAt),
        sealed: record.sealedAt !== null,
        costMicros: record.costMicros?.toString() ?? null,
        costBasis: record.costBasis,
      };
    });
    if (!run) {
      logger.warn({ runId }, "cost.run-progress: no store has this run");
      return { runId, rolledUp: false };
    }

    await step.run("daily-totals", () =>
      rebuildDailyTotals({
        orgId: run.orgId,
        workspaceId: run.workspaceId,
        day: run.day,
      }),
    );
    logger.info(
      {
        runId,
        sealed: run.sealed,
        costMicros: run.costMicros,
        costBasis: run.costBasis,
      },
      "cost.run-progress complete",
    );
    return { runId, rolledUp: true };
  },
);
