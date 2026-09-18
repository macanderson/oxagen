/**
 * The shape of an `org.model_credentials` row's non-secret columns — the
 * provider values its CHECK admits and how its `model_map` is read.
 *
 * Its own module, apart from the resolver, because it is pure. The resolver
 * opens a KMS envelope, reads Postgres and logs, so every handler test mocks
 * it wholesale — and a pure helper living behind a wholly-mocked module
 * silently vanishes from every one of those tests (`toCredentialView` needs
 * `parseModelMap`, and the set/delete/verify suites mock the resolver). Pure
 * logic here is imported for real everywhere, which is what it should be.
 *
 * No imports, on purpose: this must stay loadable with no database, no env
 * and no KMS.
 */

/**
 * The vendors `org.model_credentials.provider` admits (its CHECK). Spelled out
 * here rather than imported from the contract because `@oxagen/database` sits
 * below `@oxagen/oxagen` in the graph. `model-credential-providers.drift.test.ts`
 * in `@oxagen/ai` pins this list, the contract's, and the Postgres CHECK to
 * one another — it lives there because that package depends on both.
 */
export const MODEL_CREDENTIAL_PROVIDERS = [
  "openrouter",
  "gateway",
  "openai",
  "anthropic",
  "openai_compatible",
] as const;
export type ModelCredentialProvider =
  (typeof MODEL_CREDENTIAL_PROVIDERS)[number];

/** The tiers a credential's `model_map` may name. */
export const MODEL_MAP_TIERS = ["fast", "balanced", "precise"] as const;
export type ModelCredentialModelMap = Partial<
  Record<(typeof MODEL_MAP_TIERS)[number], string>
>;

/**
 * Read `model_map` without trusting it. It is jsonb, so the column type says
 * nothing about the shape, and every consumer downstream indexes it by tier
 * and hands the value to a vendor as a model id. Anything that is not a
 * non-empty string under a known tier is dropped rather than passed along —
 * a dropped entry falls back to the balanced mapping, where a passed-through
 * object would reach the vendor as a model id and fail somewhere stranger.
 *
 * The settings page and the runtime both read through this, so the page
 * shows exactly the mapping the assistant will act on.
 */
export function parseModelMap(raw: unknown): ModelCredentialModelMap {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: ModelCredentialModelMap = {};
  for (const tier of MODEL_MAP_TIERS) {
    const value = (raw as Record<string, unknown>)[tier];
    if (typeof value === "string" && value.length > 0) out[tier] = value;
  }
  return out;
}
