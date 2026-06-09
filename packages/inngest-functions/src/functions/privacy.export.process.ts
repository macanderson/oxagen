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
 *   2. Assemble the export ZIP (conversations, profile, api-keys metadata, audit
 *      events, generated asset metadata). NOTE: ZIP assembly is a stub — the
 *      signed download URL construction is pending the full data-collection
 *      pipeline. Track in Linear OXA-XXXX.
 *   3. Mark record as `ready` with the signed `exportUrl`.
 *
 * Failure: on any unrecoverable error the row is marked `failed` with the reason
 * in `errorMessage`, then the error is rethrown so Inngest records the failure.
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

    // Step 2: assemble export package
    // TODO(OXA-privacy): implement full ZIP assembly:
    //   - user-profile.json (users table)
    //   - conversations/*.json (conversations + messages)
    //   - api-keys.json (key metadata, never values)
    //   - audit-log.json (security_events where subject_id = userId)
    //   - generated-assets.json (generated_assets metadata)
    // For org scope: include all members + all workspaces.
    // Upload assembled ZIP to Vercel Blob and capture the signed URL.
    const exportUrl = await step.run("assemble-export", async () => {
      logger.info({ exportId, userId, orgId, scope }, "privacy.export-process: assembling export (stub)");
      // Stub: return a placeholder until full assembly pipeline is wired.
      return `https://placeholder.export.oxagen.ai/${exportId}.zip`;
    });

    // Step 3: mark ready
    await step.run("mark-ready", async () => {
      await withSystemDb((tx) =>
        tx
          .update(schema.privacyExportRequests)
          .set({
            status: "ready",
            exportUrl,
            completedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.privacyExportRequests.id, exportId)),
      );
    });

    logger.info({ exportId, userId, orgId, scope }, "privacy.export-process completed");

    return { exportId, status: "ready", exportUrl };
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
