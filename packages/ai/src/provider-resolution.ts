/**
 * How a model id becomes a `LanguageModel`.
 *
 * The Vercel AI Gateway is still the default and still the only path a
 * deployment with `AI_GATEWAY_API_KEY` set will take. What this adds is the
 * BYOK half the product has always claimed and never had: when no gateway
 * credential is configured, a model whose vendor DOES have a direct key
 * resolves through that vendor's own provider instead of failing.
 *
 * Why this is a fallback and not a router. Routing every call at the vendor's
 * door would quietly cost a deployment the things it bought the gateway for —
 * cross-provider failover, one billing surface, one place to rotate a key. So
 * the gateway wins whenever it is configured, and an operator who genuinely
 * wants the direct path says so with `OXAGEN_MODEL_ROUTING=direct`. Nothing
 * about an existing deployment changes.
 *
 * What does NOT change either way: metering. Token accounting, the credit
 * charge, tenant scope and the OTEL span all live in `streamAgentReply`'s
 * wrapper around whatever `LanguageModel` it is handed — never in the provider.
 * A direct-provider call is billed exactly like a gateway call, which is the
 * property that makes this safe to ship rather than a metering hole.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { gateway } from "@ai-sdk/gateway";
import type { LanguageModelV4 } from "@ai-sdk/provider";

/**
 * Vendors reachable without the gateway, keyed by the prefix a model id
 * carries (`anthropic/claude-...`). Each entry names the env var holding that
 * vendor's key and builds the model from the bare slug.
 *
 * Deliberately a table rather than a chain of ifs: adding a vendor should be
 * one row plus its `requireEnv` declaration, not a new branch in the resolver.
 */
const DIRECT_PROVIDERS: Record<
  string,
  {
    envVar: string;
    /**
     * Recognizes this vendor's own bare slug, for ids that arrive with the
     * `vendor/` prefix already stripped. A resolved id round-trips through the
     * platform (a response reports `claude-haiku-4-5`, not
     * `anthropic/claude-haiku-4-5`) and comes back here for the next call — so
     * treating an unprefixed id as unroutable would silently send the second
     * call of every turn somewhere the first did not go.
     */
    owns: (bareModelId: string) => boolean;
    build: (apiKey: string, bareModelId: string) => LanguageModelV4;
  }
> = {
  anthropic: {
    envVar: "ANTHROPIC_API_KEY",
    owns: (id) => id.startsWith("claude-"),
    build: (apiKey, bareModelId) => createAnthropic({ apiKey })(bareModelId),
  },
};

/**
 * Split `vendor/model` into its parts, or recover the vendor from a bare slug
 * a direct provider recognizes. Returns null when nothing claims it.
 */
function locateVendor(
  modelId: string,
): { vendor: string; bare: string } | null {
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    return { vendor: modelId.slice(0, slash), bare: modelId.slice(slash + 1) };
  }
  for (const [vendor, provider] of Object.entries(DIRECT_PROVIDERS)) {
    if (provider.owns(modelId)) return { vendor, bare: modelId };
  }
  return null;
}

/** Whether the gateway is usable at all. */
function gatewayConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env["AI_GATEWAY_API_KEY"]);
}

/** Model ids already announced, so the notice is one line per id, not per call. */
const announced = new Set<string>();

/**
 * Resolve `modelId` to a `LanguageModel`.
 *
 * Order:
 *  1. `OXAGEN_MODEL_ROUTING=direct` — prefer the vendor's own provider.
 *  2. No gateway credential — fall back to the vendor's own provider.
 *  3. Otherwise the gateway, exactly as before.
 *
 * A vendor with no direct entry, or no key for the one it has, still goes to
 * the gateway: this never fails a call it could otherwise have made.
 */
export function resolveLanguageModel(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): LanguageModelV4 {
  // One line the first time each model id is resolved. Which arm was taken is
  // the difference between "the gateway key is dead" being a five-minute
  // diagnosis and an afternoon of reading stack traces that name neither.
  if (!announced.has(modelId)) {
    announced.add(modelId);
    console.info(
      `[oxagen/ai] model ${modelId || "(unnamed)"} -> ${describeModelRouting(modelId, env)}`,
    );
  }
  const preferDirect =
    env["OXAGEN_MODEL_ROUTING"] === "direct" || !gatewayConfigured(env);
  if (!preferDirect) return gateway.languageModel(modelId);

  const located = locateVendor(modelId);
  const direct = located ? DIRECT_PROVIDERS[located.vendor] : undefined;
  const apiKey = direct ? env[direct.envVar] : undefined;
  if (direct && located && apiKey) return direct.build(apiKey, located.bare);

  return gateway.languageModel(modelId);
}

/**
 * Which path {@link resolveLanguageModel} would take, for logging and for the
 * boot-time notice. Naming the arm is the difference between "the gateway key
 * is dead" being a five-minute diagnosis and an afternoon.
 */
export function describeModelRouting(
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): "gateway" | "direct" {
  const preferDirect =
    env["OXAGEN_MODEL_ROUTING"] === "direct" || !gatewayConfigured(env);
  if (!preferDirect) return "gateway";
  const located = locateVendor(modelId);
  const direct = located ? DIRECT_PROVIDERS[located.vendor] : undefined;
  return direct && env[direct.envVar] ? "direct" : "gateway";
}
