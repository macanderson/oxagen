import pino from "pino";
import { experimental_generateVideo } from "ai";
import type { Experimental_VideoModelV4 } from "@ai-sdk/provider";
import {
  insertTokenUsage,
  providerFromModelId,
  type Surface,
} from "@oxagen/telemetry";
import {
  chargeVideoCredits,
  videoProviderCostUsdMicros,
} from "@oxagen/billing";
import { getScope, runInTenantScope, type TenantScope } from "@oxagen/tenancy";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "ai.video" },
});

/**
 * VideoModel mirrors the `VideoModel` type from the `ai` package (which is not
 * publicly exported). It is `string | Experimental_VideoModelV4` — a bare
 * gateway model-id string OR a typed video model object from `@ai-sdk/gateway`.
 */
export type VideoModel = string | Experimental_VideoModelV4;

// Video models bill PER ASSET (priced per second of output), not per token. The
// real per-second cost by model lives in VIDEO_RATE_CARD in @oxagen/billing;
// this module reads it via videoProviderCostUsdMicros (telemetry) and
// chargeVideoCredits (the gate), so every render is metered at its actual
// provider price under the same markup as text — no hardcoded constant.

// Fixed sentinel written to token_usage.prompt_hash so ClickHouse can filter
// video-generation rows. The `model` column carries the real model id.
const VIDEO_PROMPT_HASH_SENTINEL = "video-generation";

// ── Supported output durations ────────────────────────────────────────────────
//
// Video providers accept only a discrete set of output durations, and an
// unsupported value fails the whole render at the gateway — Veo 3 text_to_video
// rejects anything outside [4, 6, 8] seconds with a 500. The video.generate
// contract deliberately keeps a wide, provider-neutral 1–60s input range, so
// this chokepoint snaps every request to a duration the resolved model actually
// supports:
//   - unsupported request → nearest supported duration (ties → longer clip)
//   - no request → the SHORTEST supported duration (cheapest render)
//   - unknown model → pass the request through untouched
// Keyed by gateway model-id prefix (longest match wins) so env-var model swaps
// (veo-3.0-fast, veo-3.1, …) stay covered. Durations must be listed ascending.
const VIDEO_MODEL_DURATIONS: Record<string, readonly number[]> = {
  "google/veo": [4, 6, 8],
  "openai/sora-2": [4, 8, 12],
};

/**
 * The discrete output durations (seconds) the given gateway video model
 * supports, resolved by longest-prefix match, or `undefined` when the model has
 * no known constraint (unknown models pass the caller's duration through).
 */
export function supportedVideoDurations(
  modelId: string,
): readonly number[] | undefined {
  let best: { key: string; durations: readonly number[] } | null = null;
  for (const [key, durations] of Object.entries(VIDEO_MODEL_DURATIONS)) {
    if (modelId.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, durations };
    }
  }
  return best?.durations;
}

export interface ResolvedVideoDuration {
  /** The duration actually sent to the provider (undefined only for unknown models with no request). */
  effectiveSeconds?: number;
  /** The caller's original request, echoed for messaging. */
  requestedSeconds?: number;
  /** True when a requested duration had to be snapped to a supported one. */
  adjusted: boolean;
  /** The model's supported duration set, when known. */
  supportedSeconds?: readonly number[];
}

/**
 * Resolve the output duration to send the provider. Requested durations the
 * model doesn't support snap to the nearest supported value (ties resolve to
 * the longer clip); an absent request selects the model's shortest supported
 * duration; unknown models pass the request through untouched.
 */
export function resolveVideoDurationSeconds(
  modelId: string,
  requestedSeconds?: number,
): ResolvedVideoDuration {
  const supported = supportedVideoDurations(modelId);
  if (!supported || supported.length === 0) {
    return {
      effectiveSeconds: requestedSeconds,
      requestedSeconds,
      adjusted: false,
    };
  }
  if (requestedSeconds === undefined) {
    return {
      effectiveSeconds: supported[0],
      adjusted: false,
      supportedSeconds: supported,
    };
  }
  if (supported.includes(requestedSeconds)) {
    return {
      effectiveSeconds: requestedSeconds,
      requestedSeconds,
      adjusted: false,
      supportedSeconds: supported,
    };
  }
  const nearest = supported.reduce((best, d) => {
    const dDist = Math.abs(d - requestedSeconds);
    const bestDist = Math.abs(best - requestedSeconds);
    return dDist < bestDist || (dDist === bestDist && d > best) ? d : best;
  });
  return {
    effectiveSeconds: nearest,
    requestedSeconds,
    adjusted: true,
    supportedSeconds: supported,
  };
}

export interface VideoDurationAlternative {
  /** Gateway model-id prefix (a valid model selector for video.generate). */
  model: string;
  /** Full supported duration set for that model. */
  supportedSeconds: readonly number[];
  /** The supported duration closest to the caller's request. */
  closestSeconds: number;
}

/**
 * Rank the known video models by how closely they can match a requested
 * duration — used to tell the user which providers get nearer their ask when
 * the selected model can't honour it. The current model is excluded.
 */
export function videoDurationAlternatives(
  requestedSeconds: number,
  currentModelId?: string,
): VideoDurationAlternative[] {
  return Object.entries(VIDEO_MODEL_DURATIONS)
    .filter(([key]) => !currentModelId?.startsWith(key))
    .map(([model, supportedSeconds]) => ({
      model,
      supportedSeconds,
      closestSeconds: supportedSeconds.reduce((best, d) =>
        Math.abs(d - requestedSeconds) < Math.abs(best - requestedSeconds) ||
        (Math.abs(d - requestedSeconds) === Math.abs(best - requestedSeconds) &&
          d > best)
          ? d
          : best,
      ),
    }))
    .sort(
      (a, b) =>
        Math.abs(a.closestSeconds - requestedSeconds) -
        Math.abs(b.closestSeconds - requestedSeconds),
    );
}

export interface GenerateVideoForArgs {
  /**
   * The video model to pass to `experimental_generateVideo`. In AI SDK v6
   * `VideoModel` is `string | Experimental_VideoModelV4`. `selectVideoModel()`
   * returns an `Experimental_VideoModelV4` built via `gateway.video(modelId)`;
   * you may also pass a bare model-id string and the gateway resolves it.
   */
  model: VideoModel;
  /** The text prompt describing the video to generate. */
  prompt: string;
  /**
   * Requested output duration in seconds. Snapped to the model's supported
   * duration set before the provider call (nearest value; absent → shortest);
   * see resolveVideoDurationSeconds. The value actually used is returned as
   * `effectiveDurationSeconds`.
   */
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
  /**
   * The output duration actually requested from the provider after snapping to
   * the model's supported set (see resolveVideoDurationSeconds). Undefined only
   * for unknown models called with no duration (provider default applies).
   */
  effectiveDurationSeconds?: number;
}

/**
 * Resolve the model id string from a VideoModel value. In AI SDK v6
 * VideoModel is `string | Experimental_VideoModelV4`; the VideoModelV4 object
 * exposes `modelId` on its spec, but the public interface only guarantees the
 * provider duck-type. We read `modelId` defensively for telemetry only — the
 * billing/telemetry model column is a string label, not a routing key.
 */
function videoModelIdOf(model: VideoModel): string {
  if (typeof model === "string") return model;
  // Experimental_VideoModelV4 exposes modelId via the provider spec.
  const candidate = (model as unknown as { modelId?: string }).modelId;
  return candidate ?? "unknown-video-model";
}

/**
 * Generate a video via the Vercel AI SDK `experimental_generateVideo` primitive,
 * with full telemetry instrumentation and credit billing.
 *
 * Timeout note: Veo renders can take several minutes. The gateway client
 * (`@ai-sdk/gateway`) uses Node's undici under the hood. We pass an `abortSignal`
 * from a 750-second AbortController so the call surfaces a clean timeout error
 * rather than hanging indefinitely. 750s sits under the API function's 800s
 * Vercel `maxDuration` (apps/api/build.mjs) with headroom for the blob upload —
 * the abort must fire BEFORE the platform kills the invocation, or the render
 * dies as an opaque 504 and the failure path never runs. The Inngest function
 * allows more wall-clock time on top (agent.video-render.ts `timeouts`).
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
  // 750s wall-clock timeout — Veo renders are slow; this surfaces a clean
  // AbortError rather than an indefinite hang. Must stay under the serving
  // function's Vercel maxDuration (800s, apps/api/build.mjs) so the abort wins
  // the race against the platform killing the invocation.
  const timeoutMs = 750 * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const resolvedModelId = videoModelIdOf(args.model);

  // Snap the duration to the model's supported set — an unsupported value fails
  // the whole render at the gateway. Billing below uses the same effective
  // value so we never charge for seconds the provider didn't produce.
  const duration = resolveVideoDurationSeconds(
    resolvedModelId,
    args.durationSeconds,
  );
  if (duration.adjusted) {
    logger.warn(
      {
        model: resolvedModelId,
        requestedSeconds: duration.requestedSeconds,
        effectiveSeconds: duration.effectiveSeconds,
        supportedSeconds: duration.supportedSeconds,
      },
      "generateVideo: requested duration unsupported by model — snapped to nearest",
    );
  }

  const startedAt = Date.now();

  let result: Awaited<ReturnType<typeof experimental_generateVideo>>;
  try {
    result = await experimental_generateVideo({
      model: args.model,
      prompt: args.prompt,
      duration: duration.effectiveSeconds,
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

  const costUsdMicros = videoProviderCostUsdMicros(
    resolvedModelId,
    duration.effectiveSeconds,
  );

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
  //
  // chargeVideoCredits → consumeCredits → withTenantDb → requireScope, which
  // needs an active tenant scope. Request-path callers have one; Inngest workers
  // deliberately keep tenant scope tight around their own DB ops and do NOT wrap
  // the long render step, so this charge would otherwise run scopeless and throw
  // TenantScopeError (silently swallowed → free renders, a revenue leak). Prefer
  // the active ALS scope, else rebuild it from the trusted telemetry
  // org/workspace so the charge always runs inside a valid scope. Mirrors
  // stream.ts's onFinish handling.
  const capturedScope: TenantScope = getScope() ?? {
    orgId: args.telemetry.orgId,
    workspaceId: args.telemetry.workspaceId,
  };
  try {
    await runInTenantScope(capturedScope, async () => {
      await chargeVideoCredits({
        orgId: args.telemetry.orgId,
        referenceId: args.telemetry.executionStepId,
        model: resolvedModelId,
        durationSeconds: duration.effectiveSeconds,
      });
    });
  } catch (err) {
    // Swallow — credit metering must never fail a capability call.
    logger.error({ err }, "generateVideo credit charge failed");
  }

  return {
    bytes,
    mimeType,
    durationMs,
    effectiveDurationSeconds: duration.effectiveSeconds,
  };
}
