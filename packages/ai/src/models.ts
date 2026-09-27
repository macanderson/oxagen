import { createGateway, gateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { requireEnv } from "@oxagen/config/env";
import { fetchWithoutRedirects } from "@oxagen/config/public-url";
import type { ModelCredentialProvider } from "@oxagen/oxagen/contracts/org.model_credential.shared";
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

/**
 * A customer's own model-vendor key (ADR-053 §2), resolved per organisation by
 * `resolveModelFundingSource` and handed here so the provider client is built
 * on it instead of on the process environment. `digest` is the client cache
 * key: a rotated key produces a new digest, so the client built on the old key
 * is dropped rather than reused. Never log the key.
 */
export interface ModelCredential {
  provider: ModelCredentialProvider;
  apiKey: string;
  digest: string;
  /**
   * The customer's endpoint. Set for `openai_compatible` and null for every
   * provider whose URL Oxagen spells. The database enforces that pairing and
   * that this is https; the loopback/RFC1918/metadata range check ran in the
   * handler before the row was ever written.
   */
  baseUrl?: string | null;
  /**
   * Which concrete model each tier means on THIS key. A direct-vendor key
   * needs it — `api.openai.com` does not know `anthropic/claude-sonnet-5` —
   * and a routed key ignores it.
   */
  modelMap?: Partial<Record<OxagenTier, string>> | null;
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
   * The organisation's own key. When set, the language model is built on it
   * and the platform key is never read. When absent, the platform provider
   * from `OXAGEN_MODEL_PROVIDER` serves the call.
   */
  credential?: ModelCredential;
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
  return applyDevtools(
    languageProvider(selector.credential).languageModel(wireModelId(selector)),
  );
}

/** The id the selected model is asked for by name, on the key that serves it. */
function wireModelId(selector: ModelSelector): string {
  const env = requireEnv([
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
  ] as const);
  const tier = selector.tier ?? DEFAULT_TIER;
  return selector.model === undefined
    ? tierModelFor(tier, tierFromEnv(env, tier), selector.credential)
    : explicitModelFor(selector.model, tier, env, selector.credential);
}

/**
 * What one selected model is called, to each thing that asks.
 *
 * A direct-vendor key makes one string mean two things, and it cannot. The
 * turn sends `api.openai.com` the vendor's own spelling (`gpt-5.2`), because
 * that is the only id it answers to. Everything that reasons ABOUT the model —
 * the catalog (`supportsReasoning`), the posture matrix, the provider
 * tool-count ceilings, the provider column on `token_usage` — is keyed by the
 * gateway's `creator/model` id, and a bare `gpt-5.2` matches none of them. So
 * the caller silently gets "unknown model": a requested reasoning effort is
 * dropped, the 128-tool refusal never fires, and the vendor of the spend is a
 * guess made from the id's first characters.
 *
 * Both ids are therefore carried, with the vendor that serves them, rather
 * than derived twice from one string. `modelIdOf` still answers the wire id;
 * nothing that sends a request changes.
 */
export interface ModelIdentity {
  /** The id the endpoint is asked for. What `modelIdOf` returns. */
  readonly wireId: string;
  /**
   * The gateway-shaped id every catalog, matrix and limit table is keyed by.
   * Equal to `wireId` except on a direct `openai` or `anthropic` key, where
   * the vendor prefix the key implies is restored.
   */
  readonly catalogId: string;
  /**
   * Who serves the call: a gateway vendor (`openai`, `anthropic`, …), the
   * credential's provider on a direct key, or null when the id names nobody.
   * `openai_compatible` is a provider too — the endpoint is the customer's,
   * and what it is called is exactly what the id cannot say.
   */
  readonly provider: string | null;
}

/** The `creator` of a gateway id, or null for a bare vendor spelling. */
function vendorPrefixOf(modelId: string): string | null {
  const slash = modelId.indexOf("/");
  return slash <= 0 ? null : modelId.slice(0, slash);
}

/**
 * The identity of one wire id on the key that serves it.
 *
 * Exported for the callers that hold a model rather than a selector — the
 * governed turn is handed a `LanguageModel` and the credential beside it.
 */
export function modelIdentityFor(
  wireId: string,
  credential?: ModelCredential,
): ModelIdentity {
  if (!credential || !isDirectVendorKey(credential)) {
    // The platform key and the two routed keys speak the gateway's catalog,
    // so the id already carries its vendor.
    return { wireId, catalogId: wireId, provider: vendorPrefixOf(wireId) };
  }
  if (credential.provider === "openai_compatible") {
    // The customer's server names its own models. A gateway prefix here would
    // be a claim about a namespace nobody has seen, so the catalog id stays
    // the bare one and the provider says which kind of endpoint it is.
    return { wireId, catalogId: wireId, provider: credential.provider };
  }
  // A direct vendor key: the model map holds the vendor's spelling, which is
  // the gateway id without its creator prefix, so the prefix restores it.
  return {
    wireId,
    catalogId: wireId.includes("/")
      ? wireId
      : `${credential.provider}/${wireId}`,
    provider: credential.provider,
  };
}

/**
 * The identity of the model `selectModel` would build for this selector,
 * resolved from the same inputs so the two can never disagree.
 */
export function resolveModelIdentity(
  selector: ModelSelector = {},
): ModelIdentity {
  return modelIdentityFor(wireModelId(selector), selector.credential);
}

const TIERS: readonly OxagenTier[] = ["fast", "balanced", "precise"];

/** The three keys whose vendor is fixed: the platform's ids mean nothing there. */
function isDirectVendorKey(credential?: ModelCredential): boolean {
  return (
    credential !== undefined &&
    credential.provider !== "openrouter" &&
    credential.provider !== "gateway"
  );
}

/**
 * What an explicit model id means on the key that is about to serve it.
 *
 * On the platform key and on the routed keys it means itself: the catalog is
 * shared, so a caller that named `openai/gpt-5.2` gets `openai/gpt-5.2`.
 *
 * On a direct-vendor key the explicit id is very often NOT the caller's
 * decision. `prepareAssistantTurn` passes the workspace's or the person's
 * stored `defaultTextModel` here, a gateway id chosen before the key existed,
 * and `api.openai.com` answers 404 to `anthropic/claude-opus-4.8`. Sending it
 * untranslated fails every turn in that workspace on a key whose balanced
 * mapping was configured exactly as the form asked. So on these keys the id
 * is read, in order, as:
 *
 *   1. one of the customer's own models — a `modelMap` value — passed through;
 *   2. a platform tier id (`OXAGEN_LLM_*`) — the tier it names, on the key;
 *   3. a gateway id for the SAME vendor (`openai/gpt-5.2` on an `openai`
 *      key) — the vendor's spelling, which is the gateway id without its
 *      creator prefix. The gateway mirrors both vendors' names; a mismatch
 *      fails loudly at call time on a choice the caller made explicitly,
 *      the same rule this file applies to the `OXAGEN_LLM_*` env;
 *   4. anything else — a catalog model this key cannot reach — runs on the
 *      selected tier's mapping, for the reason `tierModelFor` gives: a
 *      substitution the turn log names beats a 404 the customer cannot fix
 *      without finding a stored preference they may not know exists.
 *
 * `openai_compatible` skips step 3: its namespace is the customer's server's,
 * and a gateway prefix says nothing about what that server calls a model.
 */
export function explicitModelFor(
  model: string,
  tier: OxagenTier,
  env: TierEnv,
  credential?: ModelCredential,
): string {
  if (!credential || !isDirectVendorKey(credential)) return model;
  const map = credential.modelMap ?? {};
  if (Object.values(map).includes(model)) return model;
  for (const t of TIERS) {
    if (tierFromEnv(env, t) === model) {
      return tierModelFor(t, model, credential);
    }
  }
  const vendorPrefix = `${credential.provider}/`;
  if (
    (credential.provider === "openai" || credential.provider === "anthropic") &&
    model.startsWith(vendorPrefix) &&
    model.length > vendorPrefix.length
  ) {
    return model.slice(vendorPrefix.length);
  }
  return tierModelFor(tier, tierFromEnv(env, tier), credential);
}

/**
 * The model id a tier means on the key that is about to serve it.
 *
 * The platform's tier ids are gateway-shaped (`anthropic/claude-sonnet-5`).
 * OpenRouter and the Gateway both parse that shape, so for those two — and for
 * the platform's own key — the tier's id is the answer and this is a pass
 * through. A direct-vendor key is a different namespace: `api.openai.com` has
 * no model called `anthropic/claude-sonnet-5` and answers 404. The
 * credential's `modelMap` is the organisation's statement of what its own key
 * calls each tier, and it is consulted only when the credential could not
 * understand the platform id anyway.
 *
 * An unmapped tier on a direct-vendor key falls back to the BALANCED mapping,
 * never to the platform id. The contract requires balanced for these keys, so
 * there is always one of the customer's own models to fall back to — and it
 * matters, because the engine asks for more than the worker tier: the provider
 * port sends summarisation to `fast` and a verdict to `precise`
 * (`modelForRole`). Falling through to the platform id there would send
 * `anthropic/claude-haiku-4.5` to `api.openai.com` and fail the turn halfway
 * through, on a customer who configured everything the form asked for.
 *
 * The cost is stated rather than hidden: with only balanced mapped, a verdict
 * runs on the same model as the worker, so the judge is not independent in
 * the way `modelForRole` intends. That is a quality reduction on the
 * customer's own choice of model. A 404 mid-turn is an outage.
 *
 * `selector.model` — an explicit id — takes a different path, `explicitModelFor`:
 * it is passed through on the routed keys and the platform key, and read as
 * one of the customer's models, a tier, or a same-vendor gateway id on a
 * direct one.
 */
export function tierModelFor(
  tier: OxagenTier,
  platformModelId: string,
  credential?: ModelCredential,
): string {
  if (!credential) return platformModelId;
  if (credential.provider === "openrouter" || credential.provider === "gateway")
    return platformModelId;
  return (
    credential.modelMap?.[tier] ??
    credential.modelMap?.balanced ??
    platformModelId
  );
}

/**
 * Provider clients built on a customer's key, by key digest. Bounded because
 * a client holds an HTTP agent: the map is cleared once it passes the bound,
 * which is cheaper than an eviction policy for a table that stays small — one
 * entry per organisation that has brought a key and prompted recently.
 */
const credentialClients = new Map<string, LanguageProviderClient>();
const CREDENTIAL_CLIENT_BOUND = 256;

function cachedCredentialClient(
  credential: ModelCredential,
  build: () => LanguageProviderClient,
): LanguageProviderClient {
  // The endpoint is part of the identity, not just the key. An organisation
  // that moves its `openai_compatible` credential to a new URL and keeps the
  // same key has the same digest — keyed on the digest alone, it would keep
  // getting the client built on the OLD endpoint until the process restarted.
  // `modelMap` is deliberately absent: it picks the model id per call and is
  // not baked into the client.
  const key = `${credential.provider}:${credential.digest}:${credential.baseUrl ?? ""}`;
  const hit = credentialClients.get(key);
  if (hit) return hit;
  if (credentialClients.size >= CREDENTIAL_CLIENT_BOUND)
    credentialClients.clear();
  const client = build();
  credentialClients.set(key, client);
  return client;
}

/** Test seam: forget every client built on a customer key. */
export function resetCredentialClientsForTests(): void {
  credentialClients.clear();
}

interface LanguageProviderClient {
  languageModel: (id: string) => LanguageModelV4;
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
 * Only the language path is redirected. Embeddings never use this provider:
 * they go to Voyage on the platform key (packages/ai/src/embed.ts).
 *
 * Model ids are NOT rewritten between providers. The gateway spells a version
 * `claude-sonnet-4-6` and OpenRouter spells it `claude-sonnet-4.6`; mapping
 * the customer-facing tier to a vendor id is exactly what the `OXAGEN_LLM_*`
 * env vars are for, so the id is whatever the environment says and a typo
 * fails loudly at call time.
 */
function languageProvider(
  credential?: ModelCredential,
): LanguageProviderClient {
  // A customer's key wins outright (ADR-053 §2): the platform provider switch
  // below is about which key OXAGEN pays with, and it is not consulted when
  // Oxagen is not paying. Built once per key and reused across turns.
  if (credential) {
    return cachedCredentialClient(credential, () => customerClient(credential));
  }

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

  return openRouterClient(OPENROUTER_API_KEY);
}

/**
 * The endpoint for each provider whose URL Oxagen spells, so a customer pastes
 * a key and nothing else. `openai_compatible` is absent on purpose: its URL is
 * the customer's.
 *
 * Both of these are the vendor's OpenAI-compatible surface, reached through
 * `createOpenAICompatible` rather than a vendor SDK. That is a deliberate
 * choice and it has one cost worth stating plainly: Anthropic's compatible
 * endpoint does not carry prompt caching or extended thinking, so an
 * organisation on an `anthropic` credential pays full input price for the
 * assistant's system prompt on every turn where a native client would have
 * cached it.
 *
 * The alternative was `@ai-sdk/anthropic` and `@ai-sdk/openai`, which pull
 * `@ai-sdk/provider@4.0.17` while this workspace pins `4.0.2` — and the two
 * are not structurally compatible (`JSONValue` gained a `Readonly<JSONObject>`
 * arm), so every model built by one cannot be passed where the other is
 * expected. Fixing that properly means upgrading `ai`, `@ai-sdk/gateway` and
 * `@ai-sdk/provider` together across every LLM call in the repo. That is worth
 * doing and it is not this change. An organisation that wants native Anthropic
 * today has two working routes that both cache: an `openrouter` key or a
 * `gateway` key.
 */
const PROVIDER_BASE_URL = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;

/**
 * The client for one customer's credential — the whole of BYOK's reach, in
 * one switch.
 *
 * Two of the five are ROUTED: one key reaches every model in the catalog, and
 * the platform's gateway-shaped tier ids work untranslated. Three are DIRECT:
 * the key is for one vendor, those tier ids mean nothing there, and the
 * credential's `modelMap` is what makes it usable (see `tierModelFor`).
 *
 * The `openai_compatible` arm is the only one that touches a URL the customer
 * supplied. It was validated before the row was written — https by a database
 * CHECK, and off loopback/RFC1918/169.254.169.254 by the handler's
 * `assertPublicHttpUrl` — so this function does not re-validate. It also does
 * not fall back: a credential naming a provider whose client cannot be built
 * is a row the database should have refused, and guessing here would move the
 * customer's traffic onto a vendor they did not choose.
 */
function customerClient(credential: ModelCredential): LanguageProviderClient {
  switch (credential.provider) {
    case "gateway":
      return createGateway({ apiKey: credential.apiKey });
    case "openrouter":
      return openRouterClient(credential.apiKey);
    case "openai":
    case "anthropic":
      return compatibleClient(
        credential.provider,
        PROVIDER_BASE_URL[credential.provider],
        credential.apiKey,
      );
    case "openai_compatible": {
      if (!credential.baseUrl) {
        // Unreachable through the handler — the pairing CHECK refuses the row
        // — so this message is for a credential inserted by hand or a resolver
        // that dropped the column, not for anything a customer can do.
        throw new Error(
          "an openai_compatible credential has no baseUrl; the row is invalid",
        );
      }
      return compatibleClient("byok", credential.baseUrl, credential.apiKey, {
        // The customer's URL was checked when the row was written; a redirect
        // target is a URL nobody checked. The probe refuses redirects for the
        // same reason, and a policy enforced in one of them is bypassed by
        // the other, so the runtime client sends every request through the
        // same fetch.
        fetch: fetchWithoutRedirects({
          refusing: "Refusing to call the model endpoint",
        }),
      });
    }
  }
}

/** One OpenAI-compatible endpoint, on whichever key is paying. */
function compatibleClient(
  name: string,
  baseURL: string,
  apiKey: string,
  options: { fetch?: typeof fetch } = {},
): LanguageProviderClient {
  return createOpenAICompatible({
    name,
    baseURL,
    apiKey,
    supportsStructuredOutputs: true,
    ...options,
  });
}

/** The OpenRouter client, on whichever key is paying. */
function openRouterClient(apiKey: string): LanguageProviderClient {
  return createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
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
