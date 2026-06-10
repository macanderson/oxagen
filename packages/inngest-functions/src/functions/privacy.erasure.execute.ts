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
 *      - user scope: anonymise PII fields, hard-delete personal data rows.
 *      - org scope: offboard all members, cascade-delete org rows.
 *      NOTE: full hard-delete cascade is a stub pending data-inventory sign-off.
 *      Track in Linear OXA-XXXX.
 *   3. Mark record as `completed`.
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

    // Step 2: execute erasure
    // TODO(OXA-privacy): implement full hard-delete cascade:
    //   User scope:
    //     - Anonymise: users.name = 'Deleted User', users.email = '<uuid>@deleted.invalid'
    //     - Hard-delete: conversations, messages, api_keys, generated_assets, audit rows
    //     - Remove org memberships
    //   Org scope:
    //     - All of the above for each member
    //     - Hard-delete: workspaces, plugins, billing records, org row
    // All deletes must be scoped via withSystemDb (SUPERUSER bypass needed for
    // cross-tenant cascades in the erasure path). BYPASSRLS is required here.
    await step.run("execute-erasure", async () => {
      logger.info({ requestId, userId, orgId, scope }, "privacy.erasure-execute: executing erasure (stub)");

      if (scope === "user") {
        // Stub: anonymise the user record. Full cascade pending data inventory.
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
      } else {
        // org scope: stub — full org cascade pending sign-off
        logger.info({ requestId, orgId }, "privacy.erasure-execute: org erasure (stub — pending cascade implementation)");
      }
    });

    // Step 3: mark completed
    await step.run("mark-completed", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyErasureRequests)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.privacyErasureRequests.id, requestId)),
      );
    });

    logger.info({ requestId, userId, orgId, scope }, "privacy.erasure-execute completed");

    return { requestId, status: "completed" };
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
