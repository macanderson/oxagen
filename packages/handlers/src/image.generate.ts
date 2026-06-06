import { generateImageFor, selectImageModel } from "@oxagen/ai";
import { requireEnv } from "@oxagen/config/env";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageGenerate } from "@oxagen/oxagen/contracts/image.generate";
import { logger } from "./logger";

// ── Handler ───────────────────────────────────────────────────────────────
//
// Delegates image generation to generateImageFor() in @oxagen/ai, which is
// the single AI chokepoint for all image generation. generateImageFor records
// telemetry (duration_ms, surface, provider, model, image_count) and charges
// credits via the billing gate.
//
// When AI_GATEWAY_API_KEY is absent this handler returns a typed placeholder —
// it never throws (policy §0.5).

export const imageGenerateHandler: CapabilityHandler<typeof imageGenerate> = async (
  input,
  ctx,
) => {
  const alt = input.alt ?? input.prompt.slice(0, 120);

  // Image generation routes 100% through the Vercel AI Gateway. Read the gateway
  // key without throwing (it's optional in the base schema); selectImageModel()
  // builds the gateway client from it.
  let hasImagePath = false;
  try {
    const env = requireEnv(["AI_GATEWAY_API_KEY"] as const);
    hasImagePath = Boolean(env.AI_GATEWAY_API_KEY);
  } catch {
    // requireEnv throws if a value fails Zod validation; treat as no path.
    hasImagePath = false;
  }

  if (!hasImagePath) {
    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, prompt: input.prompt },
      "image.generate: AI_GATEWAY_API_KEY not configured — returning placeholder",
    );
    return {
      alt,
      placeholder: true,
      render: {
        componentId: "image-preview",
        props: { alt, placeholder: true, prompt: input.prompt },
      },
    };
  }

  try {
    // selectImageModel() is the single chokepoint for image model construction —
    // it builds the Vercel AI Gateway client internally so this handler never
    // imports a provider SDK directly. Default model: openai/gpt-image-1.
    const imageModel = selectImageModel();

    const { images, durationMs } = await generateImageFor({
      model: imageModel,
      prompt: input.prompt,
      size: input.size ?? "1024x1024",
      n: 1,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        executionStepId: ctx.messageId ?? ctx.requestId,
      },
    });

    logger.info(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, durationMs },
      "image.generate: generation complete",
    );

    // generateImageFor returns base64 strings; encode as a data URI.
    const base64 = images[0];
    const dataUri: string | undefined = base64
      ? `data:image/png;base64,${base64}`
      : undefined;

    return {
      dataUri,
      alt,
      placeholder: false,
      render: {
        componentId: "image-preview",
        props: { dataUri, alt, placeholder: false },
      },
    };
  } catch (err) {
    // Generation failed — return placeholder, never throw.
    const reason = err instanceof Error ? err.message : "unknown error";
    logger.warn(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, reason },
      "image.generate: generation failed — returning placeholder",
    );
    return {
      alt,
      placeholder: true,
      render: {
        componentId: "image-preview",
        props: { alt, placeholder: true, errorReason: reason, prompt: input.prompt },
      },
    };
  }
};
