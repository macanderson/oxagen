import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import { RUN_PULL_REQUEST_LINKED_EVENT } from "../events";
import { type WorkOrderSweepResult, workOrderResultsRunner } from "../lib/work-order-results-runner";
import { logger } from "../logger";

const sealedSchema = z.object({
  runId: z.string().min(1),
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

const linkedSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  rootSessionUuid: z.string().uuid(),
  url: z.string().url().max(2048),
});

/**
 * `cost/run.sealed` → record `run_ended` on every work order the run is
 * linked to (ADR-251). Both seal paths send the event: the host's own
 * `agent_stop` and the idle close. A run linked to no work order records
 * nothing. The runner is installed by `@oxagen/handlers/register`.
 */
export const [workOrderRunEnded] = createFunction(
  {
    id: "work/order-run-ended",
    retries: 5,
    concurrency: [{ limit: 4 }, { limit: 1, key: "event.data.runId" }],
  },
  { event: "cost/run.sealed" },
  async ({ event, step }) => {
    const parsed = sealedSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success) throw new NonRetriableError(`cost/run.sealed: malformed event data: ${parsed.error.message}`);
    return step.run("record-run-ended", () => workOrderResultsRunner().runEnded(parsed.data));
  },
);

/**
 * `run/pull-request.linked` → when the run is linked to a work order whose
 * brief changes that repository, record the pull request on the send and read
 * its head, required checks, and check results from GitHub (ADR-251). At most
 * two reads run at once per workspace, like the pull request backfill, so a
 * batch of links does not spend the workspace's GitHub rate limit at once.
 */
export const [workOrderPullRequestLinked] = createFunction(
  {
    id: "work/order-pull-request-linked",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.workspaceId" },
  },
  { event: RUN_PULL_REQUEST_LINKED_EVENT },
  async ({ event, step }) => {
    const parsed = linkedSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError(`run/pull-request.linked: malformed event data: ${parsed.error.message}`);
    return step.run("record-pull-request", () => workOrderResultsRunner().pullRequestLinked(parsed.data));
  },
);

/**
 * Hourly at 35 past: record what a lost event left out of each workspace's
 * open work orders (ADR-251). A run that sealed with no `run_ended`, because
 * its `cost/run.sealed` event was lost, gets its end. A send whose run ended
 * gets its pull request read again, because GitHub does not redeliver a
 * failed `pull_request` delivery, so a merge or close it missed reaches it.
 * The pass in @oxagen/handlers bounds what it reads per workspace.
 *
 * One workspace's failed pass does not stop the sweep, and the next hour
 * tries it again. One run at a time, so two runs never read the same pull
 * requests from GitHub at once.
 */
export const [workOrderResultsSweep] = createFunction(
  {
    id: "work/order-results-sweep",
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: "35 * * * *" },
  async ({ step }) => {
    const scopes = await step.run("list-workspaces", () => workOrderResultsRunner().sweepScopes());
    const total: WorkOrderSweepResult = { sendsEnded: 0, sendsRead: 0, factsRecorded: 0, failed: 0 };
    let passed = 0;
    for (const scope of scopes) {
      const out = await step.run(`sweep-${scope.workspaceId}`, async (): Promise<WorkOrderSweepResult | null> => {
        try {
          return await workOrderResultsRunner().sweep(scope);
        } catch (err) {
          logger.warn({ workspaceId: scope.workspaceId, err }, "work/order-results-sweep: pass failed");
          return null;
        }
      });
      if (out === null) continue;
      passed += 1;
      total.sendsEnded += out.sendsEnded;
      total.sendsRead += out.sendsRead;
      total.factsRecorded += out.factsRecorded;
      total.failed += out.failed;
    }
    const summary = { workspaces: scopes.length, passed, ...total };
    logger.info(summary, "work/order-results-sweep complete");
    return summary;
  },
);
