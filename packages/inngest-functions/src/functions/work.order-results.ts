import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import { RUN_PULL_REQUEST_LINKED_EVENT } from "../events";
import { workOrderResultsRunner } from "../lib/work-order-results-runner";

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
 * linked to (ADR-250). Both seal paths send the event: the host's own
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
 * its head, required checks, and check results from GitHub (ADR-250). At most
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
