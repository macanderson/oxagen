import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import type { ImageModel, LanguageModel } from "ai";
import { requireEnv } from "@oxagen/config/env";
import type { MediaTier, ResolvedTierCatalog } from "./catalog";

export type ProviderName = "anthropic" | "openai";

/**
 * White-labeled Oxagen model tiers. Each resolves to a concrete Vercel AI
 * Gateway model id via the `OXAGEN_LLM_*` env vars, so the customer-facing
 * names ("Oxagen Mini/Plus/Max") stay decoupled from the underlying vendor
 * model. The env defaults (see packages/config/src/env.ts) are:
 *   fast     → OXAGEN_LLM_FAST     (anthropic/claude-haiku-4.5)
 *   balanced → OXAGEN_LLM_BALANCED (anthropic/claude-sonnet-4.6)
 *   precise  → OXAGEN_LLM_PRECISE  (anthropic/claude-opus-4.8)
 */
export type OxagenTier = "fast" | "balanced" | "precise";

/** Platform default tier when a caller doesn't pick one. */
export const DEFAULT_TIER: OxagenTier = "balanced";

/**
 * Read the concrete gateway model id from a LanguageModel. In AI SDK v6
 * `LanguageModel` is a union that also admits a bare model-id string, so callers
 * can no longer access `.modelId` unconditionally — this narrows it. The
 * selectModel()/selectImageModel() factories always return a provider object, so
 * the string arm is only there to satisfy the union.
 */
export function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

export interface ModelSelector {
  /**
   * Explicit Vercel AI Gateway model id in `creator/model` form, e.g.
   * "anthropic/claude-opus-4.8" or "openai/gpt-5.2". Takes precedence over
   * `tier`.
   */
  model?: string;
  /** White-labeled tier; resolves to a gateway id from the `OXAGEN_LLM_*` env. */
  tier?: OxagenTier;
  /**
   * Direct-provider hint used ONLY on the no-gateway fallback path (when
   * AI_GATEWAY_API_KEY is absent). Ignored when the gateway is configured.
   */
  provider?: ProviderName;
}

/**
 * Vercel AI Gateway OpenAI-compatible endpoint. The gateway authenticates with
 * AI_GATEWAY_API_KEY and accepts `creator/model` ids, so a single seam reaches
 * every vendor (Anthropic, OpenAI, Google, xAI, …) without per-provider SDKs.
 * Using the already-installed @ai-sdk/openai client against this base URL keeps
 * the gateway a config change rather than a new pinned dependency.
 */
const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

/** Provider name surfaced to the AI SDK for the gateway client. */
const GATEWAY_PROVIDER_NAME = "vercel-ai-gateway";

const TIER_ENV_KEY = {
  fast: "OXAGEN_LLM_FAST",
  balanced: "OXAGEN_LLM_BALANCED",
  precise: "OXAGEN_LLM_PRECISE",
} as const satisfies Record<
  OxagenTier,
  "OXAGEN_LLM_FAST" | "OXAGEN_LLM_BALANCED" | "OXAGEN_LLM_PRECISE"
>;

type TierEnv = Record<(typeof TIER_ENV_KEY)[OxagenTier], string | undefined>;

/** Resolve a tier to its concrete gateway model id from already-read env. */
function tierFromEnv(env: TierEnv, tier: OxagenTier): string {
  // env values carry schema defaults (env.ts), so this is always a string in
  // a validated environment; coalesce defensively for mocked test envs.
  return env[TIER_ENV_KEY[tier]] ?? "anthropic/claude-sonnet-4.6";
}

/**
 * Resolve a tier to its concrete gateway model id. Public so callers (e.g. the
 * model picker / chat route) can label a tier with the model it maps to.
 */
export function tierModelId(tier: OxagenTier): string {
  const env = requireEnv([
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
  ] as const);
  return tierFromEnv(env, tier);
}

// ── Media tiers (image + video) ────────────────────────────────────────────
//
// Image and video generation expose two white-labeled tiers — "basic" (the
// default, cheaper) and "advanced" — that resolve to concrete gateway model ids
// via the OXAGEN_LLM_{IMAGE,VIDEO}_{BASIC,ADVANCED} env vars. Same pattern as
// the text tiers above: the customer-facing name stays decoupled from the
// vendor model so swapping the underlying generator is an env change.

const IMAGE_TIER_ENV_KEY = {
  basic: "OXAGEN_LLM_IMAGE_BASIC",
  advanced: "OXAGEN_LLM_IMAGE_ADVANCED",
} as const satisfies Record<MediaTier, string>;

const VIDEO_TIER_ENV_KEY = {
  basic: "OXAGEN_LLM_VIDEO_BASIC",
  advanced: "OXAGEN_LLM_VIDEO_ADVANCED",
} as const satisfies Record<MediaTier, string>;

/** Resolve an image tier to its concrete gateway model id from env. */
export function imageTierModelId(tier: MediaTier): string {
  const env = requireEnv([
    "OXAGEN_LLM_IMAGE_BASIC",
    "OXAGEN_LLM_IMAGE_ADVANCED",
  ] as const);
  // Defaults are guaranteed by the schema (env.ts); coalesce for mocked envs.
  return env[IMAGE_TIER_ENV_KEY[tier]] ?? "openai/dall-e-3";
}

/** Resolve a video tier to its concrete gateway model id from env. */
export function videoTierModelId(tier: MediaTier): string {
  const env = requireEnv([
    "OXAGEN_LLM_VIDEO_BASIC",
    "OXAGEN_LLM_VIDEO_ADVANCED",
  ] as const);
  return env[VIDEO_TIER_ENV_KEY[tier]] ?? "google/veo-3-fast";
}

/**
 * Resolve every white-labeled tier to its concrete gateway model id in a single
 * read. Server-only (reads env); the chat RSC calls this and passes the result
 * to the client model picker as one serializable prop so the picker can label
 * each tier with its underlying model without the client ever touching env.
 */
export function resolvedTierCatalog(): ResolvedTierCatalog {
  return {
    text: {
      fast: tierModelId("fast"),
      balanced: tierModelId("balanced"),
      precise: tierModelId("precise"),
    },
    image: {
      basic: imageTierModelId("basic"),
      advanced: imageTierModelId("advanced"),
    },
    video: {
      basic: videoTierModelId("basic"),
      advanced: videoTierModelId("advanced"),
    },
  };
}

// Direct-provider fallback model ids (used only when AI_GATEWAY_API_KEY is
// absent). The gateway path never reads these.
const DIRECT_DEFAULTS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
} as const satisfies Record<ProviderName, string>;

/**
 * Map a (possibly gateway-form) model id to a bare provider model id and infer
 * the owning provider, for the no-gateway fallback path only. A gateway id like
 * "anthropic/claude-sonnet-4.6" can't address a direct provider endpoint, so we
 * strip the `creator/` prefix and normalise the dotted version back to dashes.
 */
function directFallback(
  selector: ModelSelector,
): { provider: ProviderName; model: string } {
  const raw = selector.model;
  if (raw && raw.includes("/")) {
    const [creator, rest] = raw.split("/", 2);
    const provider: ProviderName = creator === "openai" ? "openai" : "anthropic";
    return { provider, model: (rest ?? "").replace(/\./g, "-") };
  }
  const provider = selector.provider ?? "anthropic";
  return { provider, model: raw ?? DIRECT_DEFAULTS[provider] };
}

/**
 * Build the language model for a request. The Vercel AI Gateway is the primary
 * path: when AI_GATEWAY_API_KEY is set, every call routes through it using the
 * requested explicit model id, else the tier (defaulting to the balanced tier).
 * When no gateway token is configured we fall back to talking to a provider SDK
 * directly so local dev / tests without a gateway still work.
 */
export function selectModel(selector: ModelSelector = {}): LanguageModel {
  const env = requireEnv([
    "AI_GATEWAY_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
  ] as const);

  // ── Primary: Vercel AI Gateway ──────────────────────────────────────────
  if (env.AI_GATEWAY_API_KEY) {
    const modelId =
      selector.model ?? tierFromEnv(env, selector.tier ?? DEFAULT_TIER);
    const gateway = createOpenAI({
      apiKey: env.AI_GATEWAY_API_KEY,
      baseURL: GATEWAY_BASE_URL,
      name: GATEWAY_PROVIDER_NAME,
    });
    return gateway(modelId);
  }

  // ── Fallback: direct provider SDKs ──────────────────────────────────────
  const { provider, model } = directFallback(selector);
  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) return anthropic(model);
    return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })(model);
  }
  if (!env.OPENAI_API_KEY) return openai(model);
  return createOpenAI({ apiKey: env.OPENAI_API_KEY })(model);
}

/** The platform default model — the balanced tier through the gateway. */
export const defaultModel = () => selectModel();

// ── Image model selection ─────────────────────────────────────────────────────
//
// Single chokepoint for all image model construction. Like selectModel(), the
// Vercel AI Gateway is the primary path so packages outside @oxagen/ai never
// import a provider SDK directly. The gateway exposes image models in the same
// `creator/model` form (e.g. "openai/dall-e-3", "bfl/flux-2",
// "google/gemini-3.1-flash-image-preview"); without a gateway token we fall
// back to OpenAI's DALL·E directly.

export interface ImageModelSelector {
  /**
   * Gateway image model id, e.g. "openai/dall-e-3" or "bfl/flux-2". On the
   * no-gateway fallback path a bare OpenAI image model id (e.g. "dall-e-3") is
   * used instead. Defaults to DALL·E 3.
   */
  model?: string;
  /**
   * Direct-provider hint for the fallback path. Currently only "openai" is a
   * supported direct image provider; ignored when the gateway is configured.
   */
  provider?: "openai";
}

const IMAGE_DEFAULT_GATEWAY = "openai/dall-e-3";
const IMAGE_DEFAULT_DIRECT = "dall-e-3";

/**
 * Build and return the AI SDK `ImageModel` for the requested model. Routes
 * through the Vercel AI Gateway when AI_GATEWAY_API_KEY is present, else through
 * the OpenAI image API directly. Callers handle the no-key / failure case
 * (placeholder) as `image.generate.ts` does — this never throws on a missing
 * key, it simply builds a client that will surface the error at call time.
 */
export function selectImageModel(selector: ImageModelSelector = {}): ImageModel {
  const env = requireEnv(["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"] as const);

  if (env.AI_GATEWAY_API_KEY) {
    const gateway = createOpenAI({
      apiKey: env.AI_GATEWAY_API_KEY,
      baseURL: GATEWAY_BASE_URL,
      name: GATEWAY_PROVIDER_NAME,
    });
    return gateway.image(selector.model ?? IMAGE_DEFAULT_GATEWAY);
  }

  // Fallback: strip any `creator/` prefix to a bare OpenAI image model id.
  const raw = selector.model;
  const modelId =
    raw && raw.includes("/")
      ? (raw.split("/", 2)[1] ?? IMAGE_DEFAULT_DIRECT)
      : (raw ?? IMAGE_DEFAULT_DIRECT);
  if (!env.OPENAI_API_KEY) return openai.image(modelId);
  return createOpenAI({ apiKey: env.OPENAI_API_KEY }).image(modelId);
}
