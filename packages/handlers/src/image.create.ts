import { generateImageFor, selectImageModel } from "@oxagen/ai";
import { requireEnv } from "@oxagen/config/env";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageCreate } from "@oxagen/oxagen/contracts/image.create";
import { persistGeneratedAsset } from "./generated-asset.persist";
import { logger } from "./logger";

// ── Handler ───────────────────────────────────────────────────────────────────
//
// Generates an image from a prompt, persists it as a workspace asset in blob
// storage + the generated_assets DB row, and returns the public asset id and
// access-controlled serving URL.
//
// All AI work routes through the Vercel AI Gateway via generateImageFor() in
// @oxagen/ai — that is the single AI + telemetry + billing chokepoint for image
// generation. This handler never imports a provider SDK directly.
//
// When AI_GATEWAY_API_KEY is absent this handler returns a placeholder URL —
// it never throws (policy §0.5).

// Map the contract model slug to the gateway model id. The contract exposes the
// two white-labeled options so the caller never references gateway paths directly.
const MODEL_ID_MAP: Record<string, string> = {
  "gpt-image-1": "openai/gpt-image-1",
  "flux-2-max": "bfl/flux-2-max",
};

export const imageCreateHandler: CapabilityHandler<typeof imageCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "image.create: rejected — no authenticated user");
    throw new Error("image.create requires an authenticated user");
  }

  // Gate on AI_GATEWAY_API_KEY — same pattern as image.generate.ts.
  let hasImagePath = false;
  try {
    const env = requireEnv(["AI_GATEWAY_API_KEY"] as const);
    hasImagePath = Boolean(env.AI_GATEWAY_API_KEY);
  } catch {
    hasImagePath = false;
  }

  if (!hasImagePath) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, prompt: input.prompt },
      "image.create: AI_GATEWAY_API_KEY not configured — returning placeholder",
    );
    return {
      image_id: `placeholder_${Date.now()}`,
      url: "https://placehold.co/1024x1024",
      created_at: new Date().toISOString(),
    };
  }

  const gatewayModelId = MODEL_ID_MAP[input.model] ?? "openai/gpt-image-1";
  const imageModel = selectImageModel({ model: gatewayModelId });

  const { images, durationMs } = await generateImageFor({
    model: imageModel,
    prompt: input.prompt,
    size: (input.size as `${number}x${number}` | undefined) ?? "1024x1024",
    n: 1,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      executionStepId: ctx.requestId ?? ctx.messageId ?? "unknown",
    },
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, durationMs },
    "image.create: generation complete",
  );

  const b64 = images[0];
  if (!b64) {
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "image.create: provider returned no image bytes — returning placeholder",
    );
    return {
      image_id: `placeholder_${Date.now()}`,
      url: "https://placehold.co/1024x1024",
      created_at: new Date().toISOString(),
    };
  }

  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "image.create: rejected — no authenticated user");
    throw new Error("image.create requires an authenticated user");
  }

  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "image",
    accessPolicy: "org",
    bytes: Buffer.from(b64, "base64"),
    mimeType: "image/png",
    prompt: input.prompt,
    model: gatewayModelId,
  });

  return {
    image_id: asset.publicId,
    url: asset.serveUrl,
    created_at: new Date().toISOString(),
  };
};
