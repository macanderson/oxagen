// run.enrich-scratch-expire.ts: deletes what a run-enrichment job left in
// scratch, a day after its read began (#4383).
//
// `run.enrich` deletes its transcript chunks when it ends, and its failure
// handler deletes them when the job fails for good. A cancelled job runs
// neither, and a delete can fail on every retry, so the objects stayed in the
// evidence bucket with nothing to remove them. The storage adapter cannot
// list a prefix, so no sweep can find them. Instead the job sends
// `RUN_ENRICH_SCRATCH_KEPT_EVENT` before its read keeps any chunk, and this
// function runs once for every such job, whatever became of it. It sleeps
// until the event's `expiresAt`, then deletes the chunks and the manifest the
// job's manifest names. A job that cleaned up after itself left no manifest,
// so the delete finds nothing to do.
import { NonRetriableError } from "@oxagen/functions";
import { runInTenantScope } from "@oxagen/tenancy";
import { z } from "zod";
import { createFunction } from "../create-function";
import {
  discardEnrichmentChunks,
  RUN_ENRICH_SCRATCH_KEPT_EVENT,
} from "../lib/run-enrichment-scratch";

export { RUN_ENRICH_SCRATCH_KEPT_EVENT };

const eventSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  /** The Inngest run id of the job that kept the objects. */
  jobRunId: z.string().min(1),
  expiresAt: z.string().datetime({ offset: true }),
});

export const [runEnrichScratchExpire] = createFunction(
  {
    id: "run.enrich-scratch-expire",
    retries: 3,
    // The same bound as `run.enrich`, so the deletes reach the blob store no
    // faster than the jobs that wrote the objects did.
    concurrency: { limit: 2 },
  },
  { event: RUN_ENRICH_SCRATCH_KEPT_EVENT },
  async ({ event, step }) => {
    const parsed = eventSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success)
      throw new NonRetriableError(
        `${RUN_ENRICH_SCRATCH_KEPT_EVENT}: malformed event data: ${parsed.error.message}`,
      );
    const { jobRunId, expiresAt, ...scope } = parsed.data;
    // A `Date`: a timestamp passed as a string would be read as a duration
    // and not wait at all.
    await step.sleep("expiry", new Date(expiresAt));
    await step.run("discard-scratch", () =>
      runInTenantScope(scope, () => discardEnrichmentChunks(scope, jobRunId)),
    );
    return { status: "expired", jobRunId };
  },
);
