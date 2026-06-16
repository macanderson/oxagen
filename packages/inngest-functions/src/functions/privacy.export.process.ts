import { NonRetriableError } from "inngest";
import { inngest } from "../inngest";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

/**
 * GDPR Article 20 — data portability export pipeline.
 *
 * Triggered by event `privacy/export.process`. The caller (privacy.data.export
 * handler) inserts a `privacyExportRequests` row with `status = 'queued'` before
 * dispatching this event.
 *
 * Steps:
 *   1. Mark record as `processing`.
 *   2. FAIL LOUD: real ZIP assembly (profile, conversations, api-key metadata,
 *      audit events, generated-asset metadata) + Blob upload + signed URL is NOT
 *      yet implemented. Until OXA-1722 ships, this function refuses to hand the
 *      user a placeholder download link marked `ready`. It throws a
 *      NonRetriableError so the `inngest/function.failed` handler marks the
 *      request `failed`. Do NOT re-add a `ready` transition with a placeholder
 *      URL — that would give a data subject a broken/fake export link.
 */
export const privacyExportProcess = inngest.createFunction(
  {
    id: "privacy.export-process",
    retries: 2,
    concurrency: { limit: 5, key: "event.data.userId" },
  },
  { event: "privacy/export.process" },
  async ({ event, step }) => {
    const { exportId, userId, orgId, scope } = event.data as {
      exportId: string;
      userId: string;
      orgId: string;
      scope: "user" | "org";
    };

    // Step 1: mark processing
    await step.run("mark-processing", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyExportRequests)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(schema.privacyExportRequests.id, exportId)),
      );
    });

    // Step 2: FAIL LOUD. Real ZIP assembly is implemented under OXA-1722:
    //   - user-profile.json (users table)
    //   - conversations/*.json (conversations + messages)
    //   - api-keys.json (key metadata, never values)
    //   - audit-log.json (security_events where subject_id = userId)
    //   - generated-assets.json (generated_assets metadata)
    //   - org scope: all members + all workspaces
    //   - upload assembled ZIP to Vercel Blob, capture the signed URL.
    // Until then we refuse to mark the request `ready` with a placeholder URL.
    logger.warn({ exportId, userId, orgId, scope }, "privacy.export-process: assembly not implemented (OXA-1722) — failing request");
    throw new NonRetriableError(
      "[privacy.export-process] export ZIP assembly not implemented (OXA-1722); " +
        `refusing to mark export request ${exportId} (scope=${scope}) as ready`,
    );
  },
);

// Failure handler — marks the export record failed so the UI can surface the error.
export const privacyExportProcessOnFailure = inngest.createFunction(
  { id: "privacy.export-process.on-failure" },
  {
    event: "inngest/function.failed",
    if: "event.data.function_id == 'privacy.export-process'",
  },
  async ({ event, step }) => {
    const failureData = event.data as {
      event?: { data?: { exportId?: string } };
      error?: unknown;
    };
    const exportId = failureData.event?.data?.exportId;
    if (!exportId) return;

    const errorMessage =
      typeof failureData.error === "object" &&
      failureData.error !== null &&
      "message" in failureData.error
        ? String((failureData.error as { message: unknown }).message)
        : String(failureData.error ?? "unknown error");

    await step.run("mark-failed", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyExportRequests)
          .set({ status: "failed", errorMessage, updatedAt: new Date() })
          .where(eq(schema.privacyExportRequests.id, exportId)),
      );
    });

    logger.error({ exportId, error: errorMessage }, "privacy.export-process failed");
  },
);
