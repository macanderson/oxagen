import { inngest } from "../inngest";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { generateVideoFor, selectVideoModel } from "@oxagen/ai";
import { storage } from "@oxagen/storage";
import { logger } from "../logger";

/**
 * Async video render pipeline.
 *
 * Triggered by event `agent/video.render`. The caller is responsible for:
 *   1. Inserting a `content.generated_assets` row with `status = 'pending'`
 *      and `kind = 'video'` BEFORE dispatching this event.
 *   2. Sending `inngest.send({ name: "agent/video.render", data: { ... } })`.
 *
 * Steps:
 *   1. Generate the video via `generateVideoFor` (Veo through Vercel AI Gateway).
 *   2. Upload raw bytes to Vercel Blob via `@oxagen/storage`.
 *   3. Update the `generated_assets` row to `status = 'ready'` with storage refs.
 *
 * Failure path: on any unrecoverable error the row is marked `status = 'failed'`
 * with the reason stored in `metadata.failureReason`, then the error is rethrown
 * so Inngest records the failure and the event appears in the dashboard.
 *
 * Timeout note:
 *   Veo renders are slow (2–5+ minutes). `generateVideoFor` internally sets a
 *   15-minute AbortController on the underlying fetch. This Inngest function is
 *   configured with `timeouts.functionRun: "16m"` — 1 minute headroom above the
 *   fetch timeout — so Inngest doesn't cancel the step before the abort fires.
 *   `retries: 0` because video generation is expensive; callers re-dispatch if
 *   needed.
 */
export const agentVideoRender = inngest.createFunction(
  {
    id: "agent.video-render",
    retries: 0,
    concurrency: { limit: 4, key: "event.data.orgId" },
    // Allow 16 minutes of wall-clock time per run. Veo renders can take
    // 2-5+ minutes; `generateVideoFor` enforces a 15-minute AbortController
    // timeout, so this gives 1 minute of headroom before Inngest cancels.
    timeouts: { functionRun: "16m" },
  },
  { event: "agent/video.render" },
  async ({ event, step }) => {
    const {
      assetId,
      orgId,
      workspaceId,
      prompt,
      model,
      mediaTier,
      durationSeconds,
      aspectRatio,
    } = event.data;

    // ── Step 1: generate the video ───────────────────────────────────────────
    const { bytes, mimeType, durationMs } = await step.run(
      "generate-video",
      async () => {
        const videoModel = selectVideoModel({
          model: model || undefined,
          tier: mediaTier,
        });

        return generateVideoFor({
          model: videoModel,
          prompt,
          durationSeconds,
          aspectRatio:
            aspectRatio === "16:9" || aspectRatio === "9:16" || aspectRatio === "1:1"
              ? aspectRatio
              : undefined,
          telemetry: {
            orgId,
            workspaceId,
            surface: "app",
            executionStepId: assetId,
          },
        });
      },
    );

    // ── Step 2: upload to storage ────────────────────────────────────────────
    const { url: storageUrl, key: storageKey, bytes: sizeBytes } = await step.run(
      "upload-to-storage",
      async () => {
        const ext = mimeType === "video/mp4" ? "mp4" : "bin";
        return storage().put({
          key: `generated/videos/${orgId}/${assetId}.${ext}`,
          body: bytes,
          contentType: mimeType,
          access: "public",
        });
      },
    );

    // ── Step 3: mark asset ready ─────────────────────────────────────────────
    await step.run("mark-ready", async () => {
      await db()
        .update(schema.generatedAssets)
        .set({
          status: "ready",
          storageKey,
          storageUrl,
          sizeBytes: BigInt(sizeBytes),
          mimeType,
          updatedAt: new Date(),
        })
        .where(eq(schema.generatedAssets.id, assetId));
    });

    logger.info(
      { assetId, orgId, workspaceId, durationMs, storageKey },
      "agent.video-render completed",
    );

    return { assetId, status: "ready", storageKey, storageUrl };
  },
);

// ── Failure handler ────────────────────────────────────────────────────────────
// Inngest v3 uses `onFailure` as a separate function triggered by Inngest when
// the main function exhausts its retries (or retries: 0 means any failure).
// We register it as a companion function to update the DB row on failure.
export const agentVideoRenderOnFailure = inngest.createFunction(
  { id: "agent.video-render.on-failure" },
  { event: "inngest/function.failed", if: "event.data.function_id == 'agent.video-render'" },
  async ({ event, step }) => {
    const originalData = event.data.event?.data as
      | { assetId?: string; orgId?: string }
      | undefined;
    const assetId = originalData?.assetId;
    if (!assetId) return;

    const errorMessage =
      typeof event.data.error === "object" &&
      event.data.error !== null &&
      "message" in event.data.error
        ? String((event.data.error as { message: unknown }).message)
        : String(event.data.error ?? "unknown error");

    await step.run("mark-failed", async () => {
      await db()
        .update(schema.generatedAssets)
        .set({
          status: "failed",
          metadata: { failureReason: errorMessage },
          updatedAt: new Date(),
        })
        .where(eq(schema.generatedAssets.id, assetId));
    });

    logger.error(
      { assetId, error: errorMessage },
      "agent.video-render failed — asset marked failed",
    );
  },
);
