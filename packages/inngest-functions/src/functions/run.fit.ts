import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { RUN_FIT_REQUESTED_EVENT } from "../events";
import { runFitRunner } from "../lib/run-fit-runner";
import { logger } from "../logger";

type RunFitRequest = { orgId: string; workspaceId: string; runId: string };

function requestOf(data: unknown): RunFitRequest | null {
  const d = data as Partial<RunFitRequest> | null;
  return typeof d?.orgId === "string" &&
    typeof d.workspaceId === "string" &&
    typeof d.runId === "string" &&
    d.runId.length > 0
    ? { orgId: d.orgId, workspaceId: d.workspaceId, runId: d.runId }
    : null;
}

/**
 * `run/fit.requested` → compute the run's Model fit reading from its record
 * and store it on the run with the seal it read (ADR-201).
 *
 * The reading calls no model, so it runs outside `run.enrich`: neither the
 * workspace's enrichment switch nor its spend cap gates it. A reseal sends the
 * event again and the new reading replaces the old one; concurrency is one per
 * run, so two seals in flight cannot race the columns. A run that is live
 * again by the time the step runs is left for its next seal. A run no store
 * holds is dropped without a retry, and a degraded store throws for Inngest to
 * retry.
 */
export const [runFit] = createFunction(
  {
    id: "run.fit",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.runId" },
  },
  { event: RUN_FIT_REQUESTED_EVENT },
  async ({ event, step }) => {
    const request = requestOf(event.data);
    if (request === null)
      throw new NonRetriableError(
        "run/fit.requested carries no orgId, workspaceId and runId",
      );
    const outcome = await step.run("read-fit", () =>
      runFitRunner()(
        { orgId: request.orgId, workspaceId: request.workspaceId },
        request.runId,
      ),
    );
    if (outcome !== "written")
      logger.info(
        { runId: request.runId, outcome },
        "run.fit: no reading written",
      );
    return { runId: request.runId, outcome };
  },
);
