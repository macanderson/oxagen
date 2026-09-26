import { NonRetriableError } from "@oxagen/functions";
import { z } from "zod";

import { createFunction } from "../create-function";
import { AGENT_INTERJECTION_RAISED_EVENT } from "../events";
import { interjectionTimeoutRunner } from "../lib/interjection-timeout-runner";

export { AGENT_INTERJECTION_RAISED_EVENT };

const eventSchema = z.object({
  orgId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  interjectionId: z.string().regex(/^inj_[0-9a-z]+$/),
  expiresAt: z.string().datetime({ offset: true }),
});

/**
 * The timeout of one question a host raised (#3941, D8). An unanswered
 * question resolves to `deny` at its deadline, and the run goes on with no
 * skills.
 *
 * 1. `resolve-repository`: name the repository the host asked about from its
 *    remote digest, so the Run page can show it and a person can link it or
 *    create a workspace for it. A failure here is recorded and never stops
 *    the timeout.
 * 2. `expiry`: sleep until the deadline the ingest computed. The wake time
 *    is a `Date`: a timestamp passed as a string would be read as a duration
 *    and not wait at all.
 * 3. `deny`: when nobody answered, record `deny` with a receipt and the audit
 *    event, and queue the message that releases the host's hold and tells the
 *    agent why. When the host's own timeout closed the row first, add the
 *    receipt and the audit event only. A person's answer is left alone.
 *
 * The runner is installed by `@oxagen/handlers/register`. The ingest sends
 * the event once per row, with the id `interjection-raised:<id>`.
 */
export const [agentInterjectionTimeout] = createFunction(
  {
    id: "agent/interjection-timeout",
    retries: 3,
    concurrency: { limit: 10, key: "event.data.workspaceId" },
  },
  { event: AGENT_INTERJECTION_RAISED_EVENT },
  async ({ event, step }) => {
    const parsed = eventSchema.safeParse(event.data);
    // A malformed event is a sender's bug; retrying it changes nothing.
    if (!parsed.success)
      throw new NonRetriableError(
        `agent/interjection.raised: malformed event data: ${parsed.error.message}`,
      );
    const request = parsed.data;
    const resolved = await step.run("resolve-repository", () =>
      interjectionTimeoutRunner().resolve(request),
    );
    await step.sleep("expiry", new Date(request.expiresAt));
    const denied = await step.run("deny", () =>
      interjectionTimeoutRunner().deny(request),
    );
    return { resolved, denied };
  },
);
