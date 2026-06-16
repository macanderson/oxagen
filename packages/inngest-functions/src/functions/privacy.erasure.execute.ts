import { NonRetriableError } from "inngest";
import { inngest } from "../inngest";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

/**
 * GDPR Article 17 — right to erasure execution pipeline.
 *
 * Triggered by `privacy/erasure.execute` after the grace period elapses (or
 * immediately when `PRIVACY_ERASURE_GRACE_DAYS=0`). The handler inserted the
 * `privacyErasureRequests` row with `status = 'queued'` and `scheduledAt` set
 * to now + grace period. Inngest retries the event delivery so the function
 * will only execute once `scheduledAt` has passed (caller sets
 * `sendAt: scheduledAt` on the Inngest event).
 *
 * Steps:
 *   1. Mark record as `processing`.
 *   2. Execute erasure:
 *      - user scope: anonymise the user PII row (real, immediate mitigation).
 *      - org scope: no-op (cascade not yet implemented).
 *   3. FAIL LOUD: the full hard-delete cascade (conversations, messages,
 *      api_keys, generated_assets, audit rows, and the org-scope cascade) is
 *      NOT yet implemented. Until OXA-1721 ships, this function refuses to mark
 *      the request `completed` — it throws a NonRetriableError so the
 *      `inngest/function.failed` handler marks the request `failed`. This keeps
 *      us GDPR-honest: we never tell a data subject their data was erased while
 *      personal data remains. Do NOT re-add a `completed` transition here until
 *      the verified cascade lands.
 *
 * Sessions were already revoked by the handler at request time (immediate effect).
 * This function handles the deferred hard-delete after the grace period.
 */
export const privacyErasureExecute = inngest.createFunction(
  {
    id: "privacy.erasure-execute",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.requestId" },
  },
  { event: "privacy/erasure.execute" },
  async ({ event, step }) => {
    const { requestId, userId, orgId, scope, scheduledAt } = event.data as {
      requestId: string;
      userId: string;
      orgId: string;
      scope: "user" | "org";
      scheduledAt: string;
    };

    // Enforce grace period: if we've been triggered before scheduledAt (clock
    // skew, early retry), sleep until the scheduled time.
    const scheduledMs = new Date(scheduledAt).getTime();
    const nowMs = Date.now();
    if (scheduledMs > nowMs) {
      await step.sleep("grace-period-wait", scheduledAt);
    }

    // Step 1: mark processing
    await step.run("mark-processing", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyErasureRequests)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(schema.privacyErasureRequests.id, requestId)),
      );
    });

    // Step 2: partial erasure — anonymise the user PII row now (real mitigation).
    // The full hard-delete cascade is implemented under OXA-1721:
    //   User scope: hard-delete conversations, messages, api_keys,
    //     generated_assets, audit rows; remove org memberships.
    //   Org scope: all of the above per member + workspaces, plugins, billing,
    //     org row.
    // All deletes must be scoped via withSystemDb (BYPASSRLS needed for the
    // cross-tenant cascade in the erasure path).
    await step.run("execute-erasure", async () => {
      logger.info({ requestId, userId, orgId, scope }, "privacy.erasure-execute: anonymising PII (partial — cascade pending OXA-1721)");

      if (scope === "user") {
        await withSystemDb(async (tx) => {
          await tx
            .update(schema.users)
            .set({
              displayName: "Deleted User",
              email: `${userId}@deleted.invalid`,
              avatarUrl: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.users.id, userId));
        });
      }
    });

    // Step 3: FAIL LOUD. The cascade is not implemented (OXA-1721). We refuse to
    // mark the request `completed` while personal data still remains, so a data
    // subject is never falsely told their data was erased. Throwing a
    // NonRetriableError routes to the on-failure handler, which marks the
    // request `failed` with this message for operator follow-up.
    throw new NonRetriableError(
      "[privacy.erasure-execute] full hard-delete cascade not implemented (OXA-1721); " +
        `refusing to mark erasure request ${requestId} (scope=${scope}) as completed`,
    );
  },
);

// Failure handler — marks erasure record failed so operators can investigate.
export const privacyErasureExecuteOnFailure = inngest.createFunction(
  { id: "privacy.erasure-execute.on-failure" },
  {
    event: "inngest/function.failed",
    if: "event.data.function_id == 'privacy.erasure-execute'",
  },
  async ({ event, step }) => {
    const failureData = event.data as {
      event?: { data?: { requestId?: string } };
      error?: unknown;
    };
    const requestId = failureData.event?.data?.requestId;
    if (!requestId) return;

    const errorMessage =
      typeof failureData.error === "object" &&
      failureData.error !== null &&
      "message" in failureData.error
        ? String((failureData.error as { message: unknown }).message)
        : String(failureData.error ?? "unknown error");

    await step.run("mark-failed", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyErasureRequests)
          .set({ status: "failed", errorMessage, updatedAt: new Date() })
          .where(eq(schema.privacyErasureRequests.id, requestId)),
      );
    });

    logger.error({ requestId, error: errorMessage }, "privacy.erasure-execute failed");
  },
);
