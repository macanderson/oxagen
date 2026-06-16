import { requireEnv } from "@oxagen/config/env";
import { eventClient } from "./event-client";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { videoTierModelId } from "@oxagen/ai";
import { createPendingGeneratedAsset } from "./generated-asset.persist";
import { logger } from "./logger";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// Kicks off an asynchronous video render:
//   1. Validates AI_GATEWAY_API_KEY is present.
//   2. Resolves the gateway model id from the "basic" video tier.
//   3. Creates a `pending` generated_assets row so the serving route returns
//      a stable URL before the render completes.
//   4. Dispatches `agent/video.render` to the Inngest queue — the async
//      worker (packages/inngest-functions/src/functions/agent.video-render.ts)
//      generates the video, uploads to blob, and flips the row to `ready`.
//   5. Returns the queued status, job id, serving URL, and a render directive
//      so the chat UI immediately shows the video-result component.
//
// The handler does NOT await the render — Veo renders take minutes.

export const videoGenerateHandler: CapabilityHandler<typeof videoGenerate> = async (
  input,
  ctx,
) => {
  // Gate on AI_GATEWAY_API_KEY — mirror image.generate.ts pattern.
  let hasGatewayKey = false;
  try {
    const env = requireEnv(["AI_GATEWAY_API_KEY"] as const);
    hasGatewayKey = Boolean(env.AI_GATEWAY_API_KEY);
  } catch {
    hasGatewayKey = false;
  }

  if (!hasGatewayKey) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, prompt: input.prompt },
      "video.generate: AI_GATEWAY_API_KEY not configured — cannot queue render",
    );
    throw new Error(
      "video.generate: AI_GATEWAY_API_KEY is not configured — video generation is unavailable",
    );
  }

  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "video.generate: rejected — no authenticated user");
    throw new Error("video.generate requires an authenticated user");
  }

  // Resolve the gateway model id from the basic video tier.
  const model = videoTierModelId("basic");

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, model, prompt: input.prompt },
    "video.generate: creating pending asset and queuing render",
  );

  // Insert a pending generated_assets row so the serving URL is stable before
  // the async render completes.
  const pending = await createPendingGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "video",
    accessPolicy: "org",
    mimeType: "video/mp4",
    prompt: input.prompt,
    model,
  });

  // Dispatch the async render job. The worker generates, uploads to blob, and
  // flips the row to `ready`.
  await eventClient.send({
    name: "agent/video.render",
    data: {
      assetId: pending.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      prompt: input.prompt,
      model,
      mediaTier: "basic",
      ...(input.durationSeconds !== undefined && { durationSeconds: input.durationSeconds }),
      ...(input.aspectRatio !== undefined && { aspectRatio: input.aspectRatio }),
    },
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, assetId: pending.id, jobId: pending.publicId },
    "video.generate: render queued",
  );

  return {
    status: "queued",
    jobId: pending.publicId,
    serveUrl: pending.serveUrl,
    render: {
      componentId: "video-result",
      props: {
        url: pending.serveUrl,
        prompt: input.prompt,
      },
    },
  };
};
