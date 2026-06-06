import { inngest } from "../inngest";
import { db, schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { generateVideoFor, selectVideoModel } from "@oxagen/ai";
import { storage } from "@oxagen/storage";
import { runInTenantScope } from "@oxagen/tenancy";
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
    // Allow 16 minutes total wall-clock time for the run to finish. Veo renders
    // can take 2-5+ minutes; `generateVideoFor` enforces a 15-minute
    // AbortController timeout, giving 1 minute of Inngest headroom.
    timeouts: { finish: "16m" },
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

    // ── Steps 1+2: generate the video and upload in a single step ───────────
    //
    // IMPORTANT: `Uint8Array` cannot cross an Inngest step boundary because
    // Inngest checkpoints results via JSON serialization — a Uint8Array round-
    // trips as `{ [index]: number }`, which would corrupt the bytes. We combine
    // generate+upload into one atomic step so raw bytes never leave the closure.
    // The step returns only JSON-safe metadata (url, key, sizes).
    const { storageUrl, storageKey, sizeBytes, durationMs, mimeType } = await step.run(
      "generate-and-upload",
      async () => {
        const videoModel = selectVideoModel({
          model: model || undefined,
          tier: mediaTier,
        });

        const { bytes, mimeType: generatedMime, durationMs: genMs } = await generateVideoFor({
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

        const ext = generatedMime === "video/mp4" ? "mp4" : "bin";
        const putResult = await storage().put({
          key: `generated/videos/${orgId}/${assetId}.${ext}`,
          body: bytes,
          contentType: generatedMime,
          access: "public",
        });

        return {
          storageUrl: putResult.url,
          storageKey: putResult.key,
          sizeBytes: putResult.bytes,
          mimeType: generatedMime,
          durationMs: genMs,
        };
      },
    );

    // ── Step 3: mark asset ready ─────────────────────────────────────────────
    // Tight DB-only block: withTenantDb is entered here (not wrapping the long
    // LLM/upload step above) per spec §6.2 transaction-span guidance.
    await step.run("mark-ready", async () => {
      await runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.generatedAssets)
            .set({
              status: "ready",
              storageKey,
              storageUrl,
              sizeBytes: BigInt(sizeBytes),
              mimeType,
              updatedAt: new Date(),
            })
            .where(eq(schema.generatedAssets.id, assetId)),
        ),
      );
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
      | { assetId?: string; orgId?: string; workspaceId?: string }
      | undefined;
    const assetId = originalData?.assetId;
    if (!assetId) return;
    const orgId = originalData?.orgId;
    const workspaceId = originalData?.workspaceId;

    const errorMessage =
      typeof event.data.error === "object" &&
      event.data.error !== null &&
      "message" in event.data.error
        ? String((event.data.error as { message: unknown }).message)
        : String(event.data.error ?? "unknown error");

    await step.run("mark-failed", async () => {
      // Scope tightly around the DB update only (no LLM/IO here).
      // Fall back to raw db() when orgId/workspaceId are missing from the
      // original event (e.g. older event schema) — these are non-null in
      // agent/video.render events but may be absent in tests/legacy data.
      if (orgId && workspaceId) {
        await runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .update(schema.generatedAssets)
              .set({
                status: "failed",
                metadata: { failureReason: errorMessage },
                updatedAt: new Date(),
              })
              .where(eq(schema.generatedAssets.id, assetId)),
          ),
        );
      } else {
        // tenancy: unscoped seam (no tenant on payload) — OXA-1515
        // originalData is missing orgId/workspaceId (legacy or malformed event).
        await db()
          .update(schema.generatedAssets)
          .set({
            status: "failed",
            metadata: { failureReason: errorMessage },
            updatedAt: new Date(),
          })
          .where(eq(schema.generatedAssets.id, assetId));
      }
    });

    logger.error(
      { assetId, error: errorMessage },
      "agent.video-render failed — asset marked failed",
    );
  },
);
