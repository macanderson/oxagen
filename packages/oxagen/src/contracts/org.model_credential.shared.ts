import { z } from "zod";

/**
 * Shared wire schemas for the ADR-053 model-credential capabilities. Not a
 * capability itself — the set, get, delete and verify contracts all import
 * from here so no surface can drift on what a provider or a redacted
 * credential looks like.
 *
 * A model credential is the organisation's own model-vendor API key. While one
 * is stored, every completion the in-app agent makes for that organisation is
 * answered on the customer's key and the customer's vendor invoice, and Oxagen
 * bills nothing for the tokens (ADR-053 §2–3).
 */

/**
 * The vendors a customer can bring a key for.
 *
 * Four are named because their endpoint is fixed and we can spell it for them:
 * an organisation pastes a key and nothing else. The fifth,
 * `openai_compatible`, is the general case — it carries the customer's own
 * `baseUrl`, which is what reaches Together, Fireworks, Groq, Azure, a
 * self-hosted vLLM, or a vendor that did not exist when this was written.
 *
 * `openrouter` and `gateway` reach every model in the catalog through one key,
 * which is why they were the first two. `openrouter` serves language models
 * only, so embeddings under an OpenRouter credential stay on the platform key
 * and are billed; `gateway` (a Vercel AI Gateway key) serves embeddings too.
 *
 * `anthropic` is native rather than routed through Anthropic's
 * OpenAI-compatible endpoint, because that endpoint drops prompt caching and
 * extended thinking — the two things the assistant's long system prompt most
 * depends on. A customer who genuinely wants the compat endpoint can still
 * reach it by choosing `openai_compatible` and giving its URL.
 */
export const modelCredentialProviderSchema = z.enum([
  "openrouter",
  "gateway",
  "openai",
  "anthropic",
  "openai_compatible",
]);

/** The providers whose endpoint the customer supplies rather than Oxagen. */
export const CUSTOMER_BASE_URL_PROVIDERS = ["openai_compatible"] as const;

/** A stored credential is `active` unless an operator has disabled it. */
export const modelCredentialStatusSchema = z.enum(["active", "disabled"]);

/**
 * The plaintext key as it arrives. Bounded so a hostile value cannot inflate
 * a log line or a ciphertext; the lower bound rejects an empty paste before
 * anything is encrypted.
 */
export const modelCredentialApiKeySchema = z.string().min(8).max(512);

/**
 * The endpoint for an `openai_compatible` credential.
 *
 * `https` only, and bounded: this URL is one an authenticated org admin typed,
 * and the server connects to it with the key in an `Authorization` header. The
 * range check that keeps it off loopback, RFC1918 and the cloud metadata
 * address lives in `@oxagen/config/public-url` and runs in the handler — a
 * regex cannot do it, because `http://2130706433/` is loopback too.
 */
export const modelCredentialBaseUrlSchema = z
  .string()
  .url()
  .max(2048)
  .startsWith("https://", { message: "the endpoint must use https" });

/**
 * Which concrete model each white-labeled tier means on THIS credential.
 *
 * Required for a direct-vendor credential and refused for the routed ones, and
 * the reason is not style. The platform's tier ids are gateway-shaped
 * (`anthropic/claude-sonnet-5`); OpenRouter and the Gateway both understand
 * that shape, so a key for either needs no map. `api.openai.com` does not —
 * asking it for `anthropic/claude-sonnet-5` is a 404, and the failure would
 * land on the customer's first question rather than when they saved the key.
 *
 * Tiers are optional individually. A direct-vendor key must map `balanced`
 * (the assistant's worker tier), and any tier it leaves unmapped runs on the
 * balanced model rather than on a platform id the vendor does not know — see
 * `tierModelFor` in `@oxagen/ai` for why that matters mid-turn.
 */
export const modelCredentialModelMapSchema = z.object({
  fast: z.string().min(1).max(200).optional(),
  balanced: z.string().min(1).max(200).optional(),
  precise: z.string().min(1).max(200).optional(),
});

/**
 * The REDACTED credential every read returns.
 *
 * Never the key. `keyHint` is the last four characters, which is what a vendor
 * dashboard shows and what an operator needs to tell two keys apart. An
 * organisation with no stored credential gets `configured: false` and null
 * everywhere else, which is the same answer the funding-source resolver gives
 * so the settings page and the runtime never disagree.
 *
 * `baseUrl` and `modelMap` ARE returned in full: neither is a secret, and the
 * settings page cannot show an operator what their endpoint is set to without
 * them. A URL that embeds a credential is refused at set time, which is what
 * keeps that true. A row written before that guard existed comes back with its
 * userinfo redacted (`toCredentialView`): the address is then not editable in
 * place, which is correct, because the stored one cannot serve a request
 * either and has to be retyped.
 */
export const modelCredentialViewSchema = z.object({
  configured: z.boolean(),
  provider: modelCredentialProviderSchema.nullable(),
  status: modelCredentialStatusSchema.nullable(),
  /** Last four characters of the stored key; null when none is stored. */
  keyHint: z.string().nullable(),
  /** The customer's endpoint for an `openai_compatible` credential, else null. */
  baseUrl: z.string().nullable(),
  /** Per-tier model ids on this credential; `{}` when none were given. */
  modelMap: modelCredentialModelMapSchema,
  /** ISO-8601 timestamp of the last successful verification against the vendor. */
  lastVerifiedAt: z.string().nullable(),
  /** ISO-8601 timestamp of the last time the key was set or replaced. */
  rotatedAt: z.string().nullable(),
});

/**
 * What a verification reports. `ok: false` carries the vendor's own message
 * so an operator sees why the key was refused rather than a generic failure.
 * The message is the vendor's text about the key, never the key.
 *
 * `toolCalling` is the second question, and the assistant's real gate. The
 * engine drives every turn by asking the model for tool calls and acting on
 * them (`createProviderPort`), so an endpoint that authenticates perfectly and
 * cannot call tools produces an assistant that answers nothing about the
 * workspace. `null` means the check could not be made — the vendor refused the
 * key, so the question never got asked.
 */
export const modelCredentialVerificationSchema = z.object({
  ok: z.boolean(),
  provider: modelCredentialProviderSchema,
  latencyMs: z.number().int().min(0),
  error: z.string().nullable(),
  toolCalling: z.boolean().nullable(),
});

export type ModelCredentialProvider = z.output<
  typeof modelCredentialProviderSchema
>;
export type ModelCredentialModelMap = z.output<
  typeof modelCredentialModelMapSchema
>;
export type ModelCredentialView = z.output<typeof modelCredentialViewSchema>;
export type ModelCredentialVerification = z.output<
  typeof modelCredentialVerificationSchema
>;

/** True when this provider's endpoint is the customer's to supply. */
export function requiresCustomerBaseUrl(
  provider: ModelCredentialProvider,
): boolean {
  return (CUSTOMER_BASE_URL_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * True when this provider will NOT understand the platform's gateway-shaped
 * tier ids, so a credential for it needs its own model map to be useful.
 */
export function requiresModelMap(provider: ModelCredentialProvider): boolean {
  return provider !== "openrouter" && provider !== "gateway";
}
