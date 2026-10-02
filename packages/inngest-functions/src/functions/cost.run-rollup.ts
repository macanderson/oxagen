import { rebuildDailyTotals, rebuildRunTotals, utcDay } from "@oxagen/billing";
import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { RUN_FIT_REQUESTED_EVENT } from "../events";
import { isInAppRun } from "../lib/in-app-run";
import { logger } from "../logger";

/**
 * `cost/run.sealed` → rebuild the run's `cost.run_totals` row from its
 * frames, then the daily groups of the workspace-day it started on, so the
 * Spend page's month reads the run within minutes of its seal (Mission
 * Control spec §12.3; ADR-060 §3). The seal writers emit the event: the tacho
 * ingest handler on an `agent_stop`. A run no store has is dropped without a
 * retry; a degraded frame store throws, and Inngest retries. Once the rows
 * land it requests a findings pass over the run's workspace (ADR-062 §4) and
 * the run's Model fit reading (ADR-201).
 *
 * An in-app assistant run gets both rows and neither request. Its cost is
 * part of what the organization spent, so the rows stay. The workspace does
 * not monitor the assistant (ADR-235, 2026-10-02 amendment), so no finding
 * and no Model fit reading is made for it.
 *
 * Concurrency is per run: two seals of one run in flight would race the same
 * row, and the last write wins either way.
 */
export const [costRunRollup] = createFunction(
  {
    id: "cost.run-rollup",
    retries: 5,
    concurrency: [{ limit: 4 }, { limit: 1, key: "event.data.runId" }],
  },
  { event: "cost/run.sealed" },
  async ({ event, step }) => {
    const { runId } = event.data as { runId: string };
    if (typeof runId !== "string" || runId.length === 0)
      throw new NonRetriableError("cost/run.sealed carries no runId");

    const run = await step.run("run-totals", async () => {
      const record = await rebuildRunTotals(runId);
      if (!record) return null;
      return {
        orgId: record.orgId,
        workspaceId: record.workspaceId,
        day: utcDay(record.startedAt),
        costMicros: record.costMicros?.toString() ?? null,
        costBasis: record.costBasis,
      };
    });
    if (!run) {
      logger.warn({ runId }, "cost.run-rollup: no store has this run");
      return { runId, rolledUp: false };
    }

    await step.run("daily-totals", () =>
      rebuildDailyTotals({
        orgId: run.orgId,
        workspaceId: run.workspaceId,
        day: run.day,
      }),
    );
    // A Tacho session (`tse_…`) is never an in-app run, so only a ledger run
    // spends a step on the read.
    const inApp =
      runId.startsWith("arun_") &&
      (await step.run("in-app-run", () =>
        isInAppRun({ orgId: run.orgId, workspaceId: run.workspaceId }, runId),
      ));
    if (inApp) {
      logger.info(
        { runId, costMicros: run.costMicros, costBasis: run.costBasis },
        "cost.run-rollup complete; an in-app run requests no findings and no Model fit",
      );
      return { runId, rolledUp: true };
    }
    await step.sendEvent("request-findings", {
      name: "cost/findings.requested",
      data: { orgId: run.orgId, workspaceId: run.workspaceId },
    });
    // The Model fit reading reads this row's tokens, so it is asked for once
    // the row has landed (#3893, ADR-201).
    await step.sendEvent("request-fit", {
      name: RUN_FIT_REQUESTED_EVENT,
      data: { orgId: run.orgId, workspaceId: run.workspaceId, runId },
    });
    logger.info(
      { runId, costMicros: run.costMicros, costBasis: run.costBasis },
      "cost.run-rollup complete",
    );
    return { runId, rolledUp: true };
  },
);
