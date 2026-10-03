import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import {
  FORGE_PULL_REQUEST_DIFF_READY_EVENT,
  type ForgePullRequestDiffReadyEventData,
} from "../events";
import { forgeRevisionCertificationRunner } from "../lib/forge-revision-certification-runner";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** @internal Exported for its unit test. */
export const forgeRevisionCertificationSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  pullRequestId: z.string().uuid(),
  revisionId: z.string().uuid(),
  provider: z.enum(["github", "gitlab"]),
  repository: z.string().min(1).max(512),
  number: z.number().int().positive(),
  headSha: z.string().regex(SHA),
  diffKey: z.string().min(1).max(1024),
  diffSha256: z.string().regex(/^[0-9a-f]{64}$/),
}) satisfies z.ZodType<ForgePullRequestDiffReadyEventData>;

/**
 * Queue each stored revision for the witness (ADR-294).
 *
 *   1. `queue-certification` writes the revision's `pending` row in
 *      `forge.revision_certifications`. A second delivery of the same event
 *      finds the row and writes nothing.
 *   2. `certify` asks the witness for a verdict on a row that is still
 *      pending. The witness is not built (ADR-064), so the step leaves the
 *      row pending and says why. When it exists, it plugs in at the runner's
 *      `certify`, and this function does not change.
 *
 * A row the witness already decided is never certified again. At most five
 * revisions per workspace are handled at once. The runner is installed by
 * `@oxagen/handlers/register`.
 */
export const [forgeRevisionCertification] = createFunction(
  {
    id: "forge/revision-certification",
    retries: 4,
    concurrency: [{ limit: 5, key: "event.data.workspaceId" }],
  },
  { event: FORGE_PULL_REQUEST_DIFF_READY_EVENT },
  async ({ event, step }) => {
    const parsed = forgeRevisionCertificationSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success)
      throw new NonRetriableError(
        `${FORGE_PULL_REQUEST_DIFF_READY_EVENT}: malformed event data: ${parsed.error.message}`,
      );
    const request = parsed.data;
    const queued = await step.run("queue-certification", () =>
      forgeRevisionCertificationRunner().queue(request),
    );
    const { certificationId } = queued;
    if (certificationId === null || queued.state !== "pending")
      return { queued };
    const certified = await step.run("certify", () =>
      forgeRevisionCertificationRunner().certify(request, certificationId),
    );
    return { queued, certified };
  },
);
