import pino from "pino";
import { experimental_generateVideo } from "ai";
import type { Experimental_VideoModelV3 } from "@ai-sdk/provider";
import {
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import { chargeVideoCredits, videoProviderCostUsdMicros } from "@oxagen/billing";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info", base: { app: "ai.video" } });

/**
 * VideoModel mirrors the `VideoModel` type from the `ai` package (which is not
 * publicly exported). It is `string | Experimental_VideoModelV3` — a bare
 * gateway model-id string OR a typed video model object from `@ai-sdk/gateway`.
 */
export type VideoModel = string | Experimental_VideoModelV3;

// Video models bill PER ASSET (priced per second of output), not per token. The
// real per-second cost by model lives in VIDEO_RATE_CARD in @oxagen/billing;
// this module reads it via videoProviderCostUsdMicros (telemetry) and
// chargeVideoCredits (the gate), so every render is metered at its actual
// provider price under the same markup as text — no hardcoded constant.

// Fixed sentinel written to token_usage.prompt_hash so ClickHouse can filter
// video-generation rows. The `model` column carries the real model id.
const VIDEO_PROMPT_HASH_SENTINEL = "video-generation";

export interface GenerateVideoForArgs {
  /**
   * The video model to pass to `experimental_generateVideo`. In AI SDK v6
   * `VideoModel` is `string | Experimental_VideoModelV3`. `selectVideoModel()`
   * returns an `Experimental_VideoModelV3` built via `gateway.video(modelId)`;
   * you may also pass a bare model-id string and the gateway resolves it.
   */
  model: VideoModel;
  /** The text prompt describing the video to generate. */
  prompt: string;
  /** Duration hint in seconds (provider may cap or ignore). */
  durationSeconds?: number;
  /** Aspect ratio in `{width}:{height}` format. */
  aspectRatio?: "16:9" | "9:16" | "1:1";
  /**
   * Required telemetry context forwarded from the caller's CapabilityContext.
   * Carries `orgId`, `workspaceId`, and `surface` so every video-generation
   * call lands in `token_usage` with provider, duration_ms, surface, and
   * asset_count. `executionStepId` is the asset id / message id that initiated
   * the render — used as the execution_step_id correlation key.
   */
  telemetry: {
    orgId: string;
    workspaceId: string;
    surface: Surface;
    executionStepId: string;
  };
}

export interface GenerateVideoForResult {
  /** Raw bytes of the first generated video. */
  bytes: Uint8Array;
  /** MIME type reported by the provider (e.g. "video/mp4"). */
  mimeType: string;
  /** Wall-clock duration of the provider call in milliseconds. */
  durationMs: number;
}

/**
 * Resolve the model id string from a VideoModel value. In AI SDK v6
 * VideoModel is `string | Experimental_VideoModelV3`; the VideoModelV3 object
 * exposes `modelId` on its spec, but the public interface only guarantees the
 * provider duck-type. We read `modelId` defensively for telemetry only — the
 * billing/telemetry model column is a string label, not a routing key.
 */
function videoModelIdOf(model: VideoModel): string {
  if (typeof model === "string") return model;
  // Experimental_VideoModelV3 exposes modelId via the provider spec.
  const candidate = (model as unknown as { modelId?: string }).modelId;
  return candidate ?? "unknown-video-model";
}

/**
 * Generate a video via the Vercel AI SDK `experimental_generateVideo` primitive,
 * with full telemetry instrumentation and credit billing.
 *
 * Timeout note: Veo renders can take several minutes. The gateway client
 * (`@ai-sdk/gateway`) uses Node's undici under the hood. We pass an `abortSignal`
 * from a 15-minute AbortController so the call surfaces a clean timeout error
 * rather than hanging indefinitely. The Inngest function's step should be
 * configured to allow at least 16 minutes of wall-clock time (handled in
 * agent.video-render.ts via the `timeouts` option on the function config).
 *
 * After generation the function records:
 * - A `token_usage` row to ClickHouse via @oxagen/telemetry (best-effort).
 *   `input_tokens` carries the asset count (= 1), `output_tokens` is 0, and
 *   `cost_usd_micros` is the real per-second provider cost for this model ×
 *   duration (VIDEO_RATE_CARD via @oxagen/billing).
 * - A credit debit through @oxagen/billing (best-effort, post-call).
 *
 * Both writes are swallowed on failure — they must never fail the caller.
 *
 * @example
 * ```ts
 * const { bytes, mimeType } = await generateVideoFor({
 *   model: selectVideoModel({ tier: "basic" }),
 *   prompt: "A timelapse of clouds over a mountain peak",
 *   durationSeconds: 5,
 *   aspectRatio: "16:9",
 *   telemetry: { orgId, workspaceId, surface: "app", executionStepId: assetId },
 * });
 * ```
 */
export async function generateVideoFor(
  args: GenerateVideoForArgs,
): Promise<GenerateVideoForResult> {
  // 15-minute wall-clock timeout — Veo renders are slow; this surfaces a clean
  // AbortError rather than an indefinite hang.
  const timeoutMs = 15 * 60 * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();

  let result: Awaited<ReturnType<typeof experimental_generateVideo>>;
  try {
    result = await experimental_generateVideo({
      model: args.model,
      prompt: args.prompt,
      duration: args.durationSeconds,
      aspectRatio: args.aspectRatio as `${number}:${number}` | undefined,
      maxRetries: 0, // Retries are expensive for video; Inngest handles retry policy.
      abortSignal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - startedAt;

  // `result.video` is the first generated file (the SDK guarantees at least one
  // when the call succeeds). `uint8Array` carries raw bytes; `mimeType` is the
  // provider-reported content type (e.g. "video/mp4").
  const video = result.video;
  const bytes: Uint8Array = video.uint8Array;
  // GeneratedFile exposes `mediaType` (not `mimeType`) in AI SDK v6.
  const mimeType: string = video.mediaType ?? "video/mp4";

  const resolvedModelId = videoModelIdOf(args.model);
  const costUsdMicros = videoProviderCostUsdMicros(resolvedModelId, args.durationSeconds);

  // `input_tokens` is repurposed to carry the asset count so the token_usage
  // schema doesn't need a new column. A value of 1 means "1 video generated".
  // output_tokens and cached_tokens are 0 — video models have no equivalent.
  try {
    await insertTokenUsage([
      {
        execution_step_id: args.telemetry.executionStepId,
        org_id: args.telemetry.orgId,
        workspace_id: args.telemetry.workspaceId,
        model: resolvedModelId,
        provider: providerFromModelId(resolvedModelId),
        input_tokens: 1,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd_micros: costUsdMicros,
        duration_ms: durationMs,
        surface: args.telemetry.surface,
        prompt_hash: VIDEO_PROMPT_HASH_SENTINEL,
        created_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Swallow — telemetry must never fail a capability call.
    logger.error({ err }, "generateVideo telemetry write failed");
  }

  // Debit the org's credits at the target margin. chargeVideoCredits prices the
  // real model + duration via VIDEO_RATE_CARD and applies the same solved meter
  // markup as text calls, so video margin matches the platform target.
  try {
    await chargeVideoCredits({
      orgId: args.telemetry.orgId,
      referenceId: args.telemetry.executionStepId,
      model: resolvedModelId,
      durationSeconds: args.durationSeconds,
    });
  } catch (err) {
    // Swallow — credit metering must never fail a capability call.
    logger.error({ err }, "generateVideo credit charge failed");
  }

  return { bytes, mimeType, durationMs };
}
