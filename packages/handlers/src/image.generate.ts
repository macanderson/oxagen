import { generateImageFor, selectImageModel } from "@oxagen/ai";
import { requireEnv } from "@oxagen/config/env";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { imageGenerate } from "@oxagen/oxagen/contracts/image.generate";
import { logger } from "./logger";
import { persistGeneratedAsset } from "./generated-asset.persist";

// ── Handler ───────────────────────────────────────────────────────────────
//
// Delegates image generation to generateImageFor() in @oxagen/ai, which is
// the single AI chokepoint for all image generation. generateImageFor records
// telemetry (duration_ms, surface, provider, model, image_count) and charges
// credits via the billing gate.
//
// When AI_GATEWAY_API_KEY is absent this handler returns a typed placeholder —
// it never throws (policy §0.5).

export const imageGenerateHandler: CapabilityHandler<
  typeof imageGenerate
> = async (input, ctx) => {
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

    // ── Persist as a conversation file ────────────────────────────────────
    // Every generated artifact must land in the Conversation Files panel, so
    // the image bytes go through the shared persistGeneratedAsset seam
    // (conversation linkage resolves from ctx.messageId inside the seam).
    // Strictly non-fatal: the inline data URI result is always returned, and
    // any failure only surfaces as `persistWarning` in the output.
    let assetPublicId: string | undefined;
    let serveUrl: string | undefined;
    let persistWarning: string | undefined;

    if (base64) {
      if (!ctx.userId) {
        persistWarning =
          "Image was not saved to conversation files: no user identity in the request context.";
      } else {
        try {
          const asset = await persistGeneratedAsset({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
            kind: "image",
            accessPolicy: "org",
            bytes: Buffer.from(base64, "base64"),
            mimeType: "image/png",
            prompt: input.prompt,
            // Record the resolved gateway model id (never a hard-coded slug —
            // AI Gateway slug-drift gotcha). AI SDK v6's `ImageModel` is
            // `string | ImageModelV3`, so narrow before touching `.modelId`.
            model:
              typeof imageModel === "string" ? imageModel : imageModel.modelId,
            messageId: ctx.messageId ?? undefined,
          });
          assetPublicId = asset.publicId;
          serveUrl = asset.serveUrl;
        } catch (persistErr) {
          logger.warn(
            { err: persistErr, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
            "image.generate: asset persistence failed (non-fatal) — returning inline result only",
          );
          persistWarning =
            "Image was generated but could not be saved to conversation files.";
        }
      }
    }

    return {
      dataUri,
      alt,
      placeholder: false,
      ...(assetPublicId !== undefined ? { assetPublicId } : {}),
      ...(serveUrl !== undefined ? { serveUrl } : {}),
      ...(persistWarning !== undefined ? { persistWarning } : {}),
      render: {
        componentId: "image-preview",
        // image-preview prefers the access-controlled serving URL over the
        // inline data URI when the asset persisted.
        props: {
          dataUri,
          alt,
          placeholder: false,
          ...(serveUrl !== undefined ? { url: serveUrl } : {}),
        },
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
        props: {
          alt,
          placeholder: true,
          errorReason: reason,
          prompt: input.prompt,
        },
      },
    };
  }
};
