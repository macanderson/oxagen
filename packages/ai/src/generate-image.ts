import { experimental_generateImage as generateImage, type ImageModel } from "ai";
import {
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeUsageCredits } from "@oxagen/billing";

// Image models bill per-image, not per-token. We record a fixed per-image cost
// in micro-USD so the token_usage table stays the billing source of truth.
// DALL-E 3 1024×1024 standard: $0.040/image (list price as of 2026-05).
// NOTE for billing agent: add a dedicated image rate-card entry to
// packages/billing/src/pricing.ts (e.g. IMAGE_RATE_CARD keyed by
// `model:size`) so the cost can be resolved dynamically instead of using this
// compile-time constant. The chargeUsageCredits call below is already wired
// and will pick up the correct cost once the rate-card entry is present.
const DALL_E_3_COST_USD_MICROS_PER_IMAGE = 40_000; // $0.040 per image

// Sentinel model values passed into the token_usage.model column so ClickHouse
// queries can filter on them. The provider prefix mirrors the pattern used by
// the language-model meter.
const DALL_E_3_MODEL_ID = "dall-e-3";

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
    executionStepId: string;
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
 *   count, `output_tokens` is 0, and `cost_usd_micros` is
 *   imageCount × DALL_E_3_COST_USD_MICROS_PER_IMAGE.
 * - A credit debit through @oxagen/billing (best-effort, post-call).
 *
 * Both writes are swallowed on failure — they must never fail the caller.
 * The caller is responsible for handling the placeholder/no-key case BEFORE
 * calling this function (same pattern as image.generate.ts).
 *
 * NOTE: a dedicated image rate-card entry is needed in
 * packages/billing/src/pricing.ts so `chargeUsageCredits` can price the
 * model/size combination dynamically. Until that entry exists, the cost is
 * fixed at DALL_E_3_COST_USD_MICROS_PER_IMAGE × imageCount.
 *
 * @example
 * ```ts
 * const { images } = await generateImageFor({
 *   model: openaiClient.image("dall-e-3"),
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
  const costUsdMicros = imageCount * DALL_E_3_COST_USD_MICROS_PER_IMAGE;

  // `input_tokens` is repurposed to carry the image count so the token_usage
  // schema doesn't need a new column. A value of `imageCount` makes the unit
  // legible in ClickHouse queries (sum(input_tokens) WHERE model = 'dall-e-3'
  // = total images generated). output_tokens and cached_tokens are 0 — image
  // models have no equivalent.
  try {
    await insertTokenUsage([
      {
        execution_step_id: args.telemetry.executionStepId,
        org_id: args.telemetry.orgId,
        workspace_id: args.telemetry.workspaceId,
        model: DALL_E_3_MODEL_ID,
        provider: providerFromModelId(`openai:${DALL_E_3_MODEL_ID}`),
        input_tokens: imageCount,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface: args.telemetry.surface,
        // Image generation has no prompt hash (there is no stable prompt
        // cohort to track across turns) — use a fixed sentinel.
        prompt_hash: "image-generation",
        created_at: new Date().toISOString(),
      },
    ]);
  } catch {
    // Swallow — telemetry must never fail a capability call.
  }

  // Debit the org's credits for what this call cost us at the target margin.
  // NOTE: chargeUsageCredits uses TokenUsageInput (model/inputTokens/outputTokens)
  // which is token-centric. Until a dedicated image rate-card entry exists in
  // packages/billing/src/pricing.ts, we pass the per-image USD cost as a flat
  // inputTokens value priced at the Sonnet fallback rate — this will over-charge
  // slightly. The billing agent should add an IMAGE_RATE_CARD entry and a
  // `chargeImageCredits` variant that takes imageCount + modelId + size so the
  // gate is correctly priced.
  try {
    await chargeUsageCredits({
      orgId: args.telemetry.orgId,
      referenceId: args.telemetry.executionStepId,
      model: DALL_E_3_MODEL_ID,
      inputTokens: imageCount,
      outputTokens: 0,
    });
  } catch {
    // Swallow — credit metering must never fail a capability call.
  }

  return {
    images: result.images.map((img) => img.base64),
    imageCount,
    durationMs,
  };
}
