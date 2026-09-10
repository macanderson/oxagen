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
 * The vendors a customer can bring a key for today.
 *
 * Both reach every model in the catalog through one key, which is what makes
 * them the first two: an organisation configures one credential and the whole
 * tier table works. `openrouter` keys are the cheapest to obtain and serve
 * language models only, so embeddings under an OpenRouter credential stay on
 * the platform key and are billed. `gateway` is a Vercel AI Gateway key and
 * serves embeddings too. Direct vendor keys (Anthropic, OpenAI) are a later
 * addition and take a new value here plus a provider client in
 * `packages/ai/src/models.ts`.
 */
export const modelCredentialProviderSchema = z.enum(["openrouter", "gateway"]);

/** A stored credential is `active` unless an operator has disabled it. */
export const modelCredentialStatusSchema = z.enum(["active", "disabled"]);

/**
 * The plaintext key as it arrives. Bounded so a hostile value cannot inflate
 * a log line or a ciphertext; the lower bound rejects an empty paste before
 * anything is encrypted.
 */
export const modelCredentialApiKeySchema = z.string().min(8).max(512);

/**
 * The REDACTED credential every read returns.
 *
 * Never the key. `keyHint` is the last four characters, which is what a vendor
 * dashboard shows and what an operator needs to tell two keys apart. An
 * organisation with no stored credential gets `configured: false` and null
 * everywhere else, which is the same answer the funding-source resolver gives
 * so the settings page and the runtime never disagree.
 */
export const modelCredentialViewSchema = z.object({
  configured: z.boolean(),
  provider: modelCredentialProviderSchema.nullable(),
  status: modelCredentialStatusSchema.nullable(),
  /** Last four characters of the stored key; null when none is stored. */
  keyHint: z.string().nullable(),
  /** ISO-8601 timestamp of the last successful verification against the vendor. */
  lastVerifiedAt: z.string().nullable(),
  /** ISO-8601 timestamp of the last time the key was set or replaced. */
  rotatedAt: z.string().nullable(),
});

/**
 * What a verification reports. `ok: false` carries the vendor's own message
 * so an operator sees why the key was refused rather than a generic failure.
 * The message is the vendor's text about the key, never the key.
 */
export const modelCredentialVerificationSchema = z.object({
  ok: z.boolean(),
  provider: modelCredentialProviderSchema,
  latencyMs: z.number().int().min(0),
  error: z.string().nullable(),
});

export type ModelCredentialProvider = z.output<
  typeof modelCredentialProviderSchema
>;
export type ModelCredentialView = z.output<typeof modelCredentialViewSchema>;
export type ModelCredentialVerification = z.output<
  typeof modelCredentialVerificationSchema
>;
