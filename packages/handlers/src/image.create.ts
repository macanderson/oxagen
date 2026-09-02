import {
  generateImageFor,
  selectImageModel,
  loadWorkspacePromptConfigSafe,
  enhancePromptIfInsufficient,
} from "@oxagen/ai";
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
// When AI_GATEWAY_API_KEY is absent, or when the provider returns no bytes,
// this handler throws so the caller receives a real error instead of a
// fabricated placeholder ID that has no DB record.

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
    logger.warn(
      { orgId: ctx.orgId },
      "image.create: rejected — no authenticated user",
    );
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
    logger.error(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "image.create: AI_GATEWAY_API_KEY not configured — image generation is unavailable",
    );
    throw new Error(
      "image.create: AI_GATEWAY_API_KEY is not configured. Image generation is unavailable.",
    );
  }

  const gatewayModelId = MODEL_ID_MAP[input.model] ?? "openai/gpt-image-1";
  const imageModel = selectImageModel({ model: gatewayModelId });

  // Auto-improve (Beta): enhance an insufficient prompt before generation when
  // the workspace toggle is on (default). Best-effort; degrades to the original.
  const promptConfig = await loadWorkspacePromptConfigSafe(ctx.workspaceId);
  const { prompt: effectivePrompt } = await enhancePromptIfInsufficient({
    prompt: input.prompt,
    kind: "image",
    autoImprove: promptConfig.autoImprovePrompts ?? true,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // requestId/messageId are UUIDs; null (not the literal "unknown", which is
      // not a UUID) when neither is set — this id lands in token_usage's UUID
      // column and credit_ledger's uuid column.
      messageId: ctx.requestId ?? ctx.messageId ?? null,
    },
  });

  const { images, durationMs } = await generateImageFor({
    model: imageModel,
    prompt: effectivePrompt,
    size: (input.size as `${number}x${number}` | undefined) ?? "1024x1024",
    n: 1,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // requestId/messageId are UUIDs; null (not the literal "unknown") when
      // neither is present so the UUID token_usage column / uuid credit_ledger
      // column receive a valid value or NULL.
      executionStepId: ctx.requestId ?? ctx.messageId ?? null,
    },
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, durationMs },
    "image.create: generation complete",
  );

  const b64 = images[0];
  if (!b64) {
    logger.error(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "image.create: provider returned no image bytes",
    );
    throw new Error(
      "image.create: image generation provider returned no image bytes. The request may have been filtered or the provider is temporarily unavailable.",
    );
  }

  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "image",
    accessPolicy: "org",
    bytes: Buffer.from(b64, "base64"),
    mimeType: "image/png",
    prompt: effectivePrompt,
    model: gatewayModelId,
    // Link to the chat turn so the asset surfaces in the Conversation Files
    // panel (persist resolves conversation_id from this message). — OXA files fix
    messageId: ctx.messageId ?? undefined,
  });

  return {
    image_id: asset.publicId,
    url: asset.serveUrl,
    created_at: new Date().toISOString(),
  };
};
