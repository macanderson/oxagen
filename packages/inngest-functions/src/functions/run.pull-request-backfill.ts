import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import { RUN_PULL_REQUEST_LINKED_EVENT } from "../events";
import { pullRequestBackfillRunner } from "../lib/run-pull-request-backfill-runner";

export { RUN_PULL_REQUEST_LINKED_EVENT };

const eventSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  rootSessionUuid: z.string().uuid(),
  url: z.string().url().max(2048),
});

/**
 * One recorded pull request link (ADR-192): store its row, then read its
 * state once from the forge. Forge webhooks keep the state current from
 * there. The delivery that opened the pull request usually lands before the
 * frame that names it, finds no row, and writes nothing, so without this
 * read the link would say "status unknown" until the pull request next
 * changed.
 *
 * The runner is installed by `@oxagen/handlers/register`. At most two reads
 * run at once per workspace, so a batch that lands many links does not spend
 * the workspace's forge rate limit in one burst.
 */
export const [runPullRequestBackfill] = createFunction(
  {
    id: "run/pull-request-backfill",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.workspaceId" },
  },
  { event: RUN_PULL_REQUEST_LINKED_EVENT },
  async ({ event, step }) => {
    const parsed = eventSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success)
      throw new NonRetriableError(
        `run/pull-request.linked: malformed event data: ${parsed.error.message}`,
      );
    return step.run("backfill", () => pullRequestBackfillRunner()(parsed.data));
  },
);
