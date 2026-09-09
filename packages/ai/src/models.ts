import { gateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { requireEnv } from "@oxagen/config/env";
import type { ResolvedTierCatalog } from "./catalog";

/**
 * Wrap a language model with AI SDK devtools middleware in development.
 *
 * Every LLM call routed through selectModel() becomes visible in the devtools
 * inspector at http://localhost:4983 (start it with `npx @ai-sdk/devtools`).
 * The middleware is a no-op outside development — the `process.env.NODE_ENV`
 * check is evaluated at call time so Next.js tree-shakes it in production
 * builds, and @ai-sdk/devtools is a devDependency so it never ships in prod.
 *
 * The catch swallows every failure and leaves the model unwrapped, so the app
 * keeps working either way. Two different failures land in it: the devDependency
 * genuinely being absent (a `--production` install), and `require` not existing
 * at all. This package is `"type": "module"`, so `require` is only defined where
 * a bundler provides it — Next.js dev does, plain `node`/`tsx` ESM does not.
 * Devtools therefore attach on the app's dev server and not on the API, MCP, or
 * CLI dev processes. Losing an inspector is the intended cost of never risking a
 * production import; do not read a quiet start-up as "devtools are running".
 */
let _devToolsMiddleware:
  | (() => import("@ai-sdk/provider").LanguageModelV4Middleware)
  | null = null;
if (process.env.NODE_ENV === "development") {
  // Eager synchronous-style load: Next.js dev mode processes this at module
  // evaluation time. We store the factory so selectModel() stays synchronous.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- devtools is a devDependency, dynamic require avoids a static import in production builds
    const devtools = require("@ai-sdk/devtools") as {
      devToolsMiddleware: () => import("@ai-sdk/provider").LanguageModelV4Middleware;
    };
    _devToolsMiddleware = devtools.devToolsMiddleware;
  } catch {
    // devtools not available — silent no-op
  }
}

/**
 * Wrap a concrete LanguageModelV4 with devtools middleware in development.
 * `gateway.languageModel()` always returns a LanguageModelV4 object (never the
 * bare string arm of the LanguageModel union), so this receives the narrowed type.
 */
function applyDevtools(model: LanguageModelV4): LanguageModelV4 {
  if (!_devToolsMiddleware) return model;
  return wrapLanguageModel({ model, middleware: _devToolsMiddleware() });
}

/**
 * White-labeled Oxagen model tiers. Each resolves to a concrete Vercel AI
 * Gateway model id via the `OXAGEN_LLM_*` env vars, so the customer-facing
 * names ("Oxagen Mini/Plus/Max") stay decoupled from the underlying vendor
 * model. The env defaults (see packages/config/src/env.ts) are:
 *   fast     → OXAGEN_LLM_FAST     (anthropic/claude-haiku-4.5)
 *   balanced → OXAGEN_LLM_BALANCED (anthropic/claude-sonnet-5)
 *   precise  → OXAGEN_LLM_PRECISE  (anthropic/claude-fable-5)
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
}

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
  return env[TIER_ENV_KEY[tier]] ?? "anthropic/claude-sonnet-5";
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
  };
}

/**
 * Build the language model for a request. Every call routes through the Vercel
 * AI Gateway (`@ai-sdk/gateway`), the platform's single AI auth boundary: the
 * gateway client reads `AI_GATEWAY_API_KEY` from the environment and accepts
 * `creator/model` ids, so one seam reaches every vendor (Anthropic, OpenAI,
 * Google, xAI, …) with no per-provider SDK or key. The model id is the explicit
 * `selector.model`, else the tier (defaulting to the balanced tier). If the
 * gateway key is missing the client still builds and surfaces an auth error at
 * call time — there is no direct-provider fallback.
 */
export function selectModel(selector: ModelSelector = {}): LanguageModel {
  const env = requireEnv([
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
  ] as const);
  const modelId =
    selector.model ?? tierFromEnv(env, selector.tier ?? DEFAULT_TIER);
  return applyDevtools(languageProvider().languageModel(modelId));
}

/**
 * The language-model provider.
 *
 * The gateway is the default and remains the platform's metered path. Setting
 * `OXAGEN_MODEL_PROVIDER=openrouter` selects a direct OpenAI-compatible
 * provider instead, for a deployment that cannot reach the gateway (for
 * example, no working `AI_GATEWAY_API_KEY`).
 *
 * Selection is EXPLICIT, never a fallback. An automatic failover on gateway
 * error would silently move spend onto a different vendor's bill and bypass
 * the metering the gateway exists to provide, and the first anyone would know
 * of it is the invoice. An operator opting out says so in the environment.
 *
 * Only the language path is redirected. `embeddingModel` stays on the gateway
 * because OpenRouter does not serve it — so embedding calls still fail on such
 * a deployment, and that is visible rather than papered over.
 *
 * Model ids are NOT rewritten between providers. The gateway spells a version
 * `claude-sonnet-4-6` and OpenRouter spells it `claude-sonnet-4.6`; mapping
 * the customer-facing tier to a vendor id is exactly what the `OXAGEN_LLM_*`
 * env vars are for, so the id is whatever the environment says and a typo
 * fails loudly at call time.
 */
function languageProvider(): {
  languageModel: (id: string) => LanguageModelV4;
} {
  const { OXAGEN_MODEL_PROVIDER, OPENROUTER_API_KEY } = requireEnv([
    "OXAGEN_MODEL_PROVIDER",
    "OPENROUTER_API_KEY",
  ] as const);

  if (OXAGEN_MODEL_PROVIDER !== "openrouter") return gateway;

  // Checked here rather than in the schema: the key is required only for this
  // one value of OXAGEN_MODEL_PROVIDER, and making it unconditionally required
  // would invalidate every gateway deployment. Failing here means a
  // misconfigured opt-out surfaces as a precise message instead of a 401 from
  // a provider the operator did not think they were calling.
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OXAGEN_MODEL_PROVIDER=openrouter requires OPENROUTER_API_KEY",
    );
  }

  return createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: OPENROUTER_API_KEY,
    // Without this, `generateObject` cannot return an object on this provider
    // at all. The SDK declines to send a JSON response format and falls back
    // to a tool call instead, whose arguments come back from Anthropic
    // through OpenRouter double-encoded:
    //
    //   {"suggestions": "{\"suggestions\": [{\"sourceRecordType\": ...}]}"}
    //
    // a string where the schema declares an array, which every
    // generateObjectFor caller fails to parse.
    supportsStructuredOutputs: true,
  });
}

/** The platform default model — the balanced tier through the gateway. */
export const defaultModel = () => selectModel();
