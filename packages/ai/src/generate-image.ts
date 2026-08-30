import pino from "pino";
import { generateImage, type ImageModel } from "ai";
import {
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import {
  chargeImageCredits,
  imageProviderCostUsdMicros,
} from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.image" },
});

// Image models bill PER IMAGE, not per token. The real per-image cost (by model
// + size) lives in IMAGE_RATE_CARD in @oxagen/billing; this module reads it via
// imageProviderCostUsdMicros (telemetry) and chargeImageCredits (the gate), so
// every image is metered at its actual provider price under the same markup as
// text — no hardcoded single-model constant.

// Fixed sentinel written to token_usage.prompt_hash so ClickHouse can filter
// image-generation rows. The `model` column carries the REAL model id (e.g.
// "bfl/flux-2-max"), not a sentinel — so per-model image analytics are accurate.
const IMAGE_PROMPT_HASH_SENTINEL = "image-generation";

/**
 * Resolve the model id string from an ImageModel for telemetry/billing. The AI
 * SDK `ImageModel` exposes `modelId` on the model spec; we read it defensively
 * (the value is a string label, not a routing key) so a future union shape can't
 * break metering.
 */
function imageModelIdOf(model: ImageModel): string {
  if (typeof model === "string") return model;
  const candidate = (model as unknown as { modelId?: string }).modelId;
  return candidate ?? "unknown-image-model";
}

export interface GenerateImageForArgs {
  /** The AI SDK ImageModel to use. */
  model: ImageModel;
  /** The prompt text passed to the image model. */
  prompt: string;
  /** Number of images to generate. Defaults to 1. */
  n?: number;
  /** Size string in `{width}x{height}` format. Defaults to "1024x1024". */
  size?: `${number}x${number}`;
  /**
   * Required telemetry context forwarded from the caller's CapabilityContext.
   * Carries `orgId`, `workspaceId`, and `surface` so every image-generation
   * call lands in `token_usage` with provider, duration_ms, surface, and
   * image_count. `executionStepId` is the request/message id that initiated
   * the turn — used as the execution_step_id correlation key.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    /**
     * UUID of the request/message that initiated the turn, or `null` when there
     * is none. Flows into `token_usage.execution_step_id` (UUID) and
     * `credit_ledger.reference_id` (Postgres uuid) — MUST be a valid UUID or
     * null, never a free-form string.
     */
    executionStepId: string | null;
  };
}

export interface GenerateImageForResult {
  /** Base64-encoded image strings, one per requested image. */
  images: string[];
  /** Number of images actually returned by the provider. */
  imageCount: number;
  /** Wall-clock duration of the provider call in milliseconds. */
  durationMs: number;
}

/**
 * Generate one or more images via the Vercel AI SDK
 * `experimental_generateImage` primitive, with full telemetry instrumentation
 * and credit billing.
 *
 * After generation the function records:
 * - A `token_usage` row to ClickHouse via @oxagen/telemetry (best-effort).
 *   Image models are billed per-image, so `input_tokens` carries the image
 *   count, `output_tokens` is 0, and `cost_usd_micros` is the real per-image
 *   provider cost for this model + size (IMAGE_RATE_CARD via @oxagen/billing).
 * - A credit debit through @oxagen/billing's `chargeImageCredits` (best-effort,
 *   post-call) — priced from IMAGE_RATE_CARD under the platform meter markup.
 *
 * Both writes are swallowed on failure — they must never fail the caller.
 * The caller is responsible for handling the placeholder/no-key case BEFORE
 * calling this function (same pattern as image.generate.ts).
 *
 * @example
 * ```ts
 * const { images } = await generateImageFor({
 *   model: selectImageModel({ model: "bfl/flux-2-max" }),
 *   prompt: "A sunset over the ocean",
 *   size: "1024x1024",
 *   telemetry: { orgId, workspaceId, surface: "api", executionStepId },
 * });
 * ```
 */
export async function generateImageFor(
  args: GenerateImageForArgs,
): Promise<GenerateImageForResult> {
  const n = args.n ?? 1;
  const startedAt = Date.now();

  const result = await generateImage({
    model: args.model,
    prompt: args.prompt,
    n,
    size: args.size,
  });

  const durationMs = Date.now() - startedAt;
  const imageCount = result.images.length;
  const modelId = imageModelIdOf(args.model);
  const size = args.size ?? "1024x1024";
  const costUsdMicros = imageProviderCostUsdMicros(modelId, imageCount, size);

  // `input_tokens` is repurposed to carry the image count so the token_usage
  // schema doesn't need a new column. The `model` column holds the real model id
  // (e.g. "bfl/flux-2-max"), so `sum(input_tokens) WHERE model = '<id>'` reads as
  // total images generated by that model. output_tokens and cached_tokens are 0.
  try {
    await insertTokenUsage([
      {
        execution_step_id: args.telemetry.executionStepId,
        org_id: args.telemetry.orgId,
        workspace_id: args.telemetry.workspaceId,
        model: modelId,
        provider: providerFromModelId(modelId),
        input_tokens: imageCount,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface: args.telemetry.surface,
        // Image generation has no prompt hash (there is no stable prompt
        // cohort to track across turns) — use a fixed sentinel.
        prompt_hash: IMAGE_PROMPT_HASH_SENTINEL,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Swallow — telemetry must never fail a capability call.
    logger.error({ err }, "generateImage telemetry write failed");
  }

  // Debit the org's credits at the target margin. chargeImageCredits prices the
  // real model + size via IMAGE_RATE_CARD and applies the same solved meter
  // markup as text calls, so image margin matches the platform target.
  //
  // chargeImageCredits → consumeCredits → withTenantDb → requireScope, which
  // needs an active tenant scope. Request-path callers have one; Inngest workers
  // keep tenant scope tight around their own DB ops and do NOT wrap the render
  // step, so this charge would otherwise run scopeless and throw TenantScopeError
  // (silently swallowed → free images, a revenue leak). Prefer the active ALS
  // scope, else rebuild it from the trusted telemetry org/workspace. Mirrors
  // stream.ts's onFinish handling.
  const capturedScope: TenantScope = getScope() ?? {
    orgId: args.telemetry.orgId,
    workspaceId: args.telemetry.workspaceId,
  };
  try {
    await runInTenantScope(capturedScope, async () => {
      await chargeImageCredits({
        orgId: args.telemetry.orgId,
        // null → undefined → NULL reference_id; never a non-UUID string.
        referenceId: args.telemetry.executionStepId ?? undefined,
        model: modelId,
        imageCount,
        size,
      });
    });
  } catch (err) {
    // Swallow — credit metering must never fail a capability call.
    logger.error({ err }, "generateImage credit charge failed");
  }

  return {
    images: result.images.map((img) => img.base64),
    imageCount,
    durationMs,
  };
}
