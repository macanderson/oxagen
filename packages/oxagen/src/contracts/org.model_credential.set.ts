import { z } from "zod";
import {
  assertPublicHttpUrl,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import { registerCapability } from "../registry";
import {
  modelCredentialApiKeySchema,
  modelCredentialBaseUrlSchema,
  modelCredentialModelMapSchema,
  modelCredentialProviderSchema,
  modelCredentialViewSchema,
  requiresCustomerBaseUrl,
  requiresModelMap,
} from "./org.model_credential.shared";

/**
 * The BASE object of the input, exported separately because the registered
 * `input` is a ZodEffects (superRefine) and therefore has no `.shape` — the
 * same reason and the same shape as `orgModelCredentialVerifyInputObject`.
 * The MCP tool builds its parameter schema from this; `invoke()` re-parses
 * the full refined input, so the cross-field rules apply on every surface.
 */
export const orgModelCredentialSetInputObject = z.object({
  provider: modelCredentialProviderSchema,
  apiKey: modelCredentialApiKeySchema,
  baseUrl: modelCredentialBaseUrlSchema.nullish(),
  modelMap: modelCredentialModelMapSchema.optional(),
});

/**
 * set_model_credential — store the organisation's own model-vendor API key
 * (ADR-053 §2).
 *
 * The plaintext key exists for the duration of the call: the handler
 * envelope-encrypts it with the KMS envelope before it reaches a column, keeps
 * only a SHA-256 digest beside the ciphertext as the provider-client cache
 * key, and returns the same REDACTED view `get_model_credential` returns.
 * Setting a key never echoes it back.
 *
 * One credential per organisation. Setting a second one replaces the first,
 * which is what a rotation is; `delete_model_credential` returns the
 * organisation to the platform key.
 *
 * Organisation-level, not workspace-level: the key pays for every workspace's
 * assistant turns, and the vendor invoice is the organisation's, so
 * `scoped: false`. Governed like the privileged mutation it is — org
 * Owner/Admin only, `sensitivity: "high"` — and audited as a
 * `model_credential.set` security event.
 *
 * No `agent` metadata on purpose: the in-app agent must never be able to set
 * the key that funds its own turns, so this capability is not materialised as
 * an agent tool.
 */
export const orgModelCredentialSet = registerCapability({
  name: "set_model_credential",
  domain: "org",
  description:
    "Store the organisation's own model-vendor API key — OpenRouter, Vercel AI Gateway, OpenAI, Anthropic, or any OpenAI-compatible endpoint given by base URL. Direct-vendor keys also take a model id per tier. While a key is stored, the in-app agent's completions run on it and Oxagen bills nothing for those tokens. The key is envelope-encrypted at rest and never readable back. Replaces any key already stored. Returns the redacted credential view.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  // Organisation-level governance: org Owner/Admin only. `workspace: {}` is
  // required by the declaration type and is deliberately EMPTY — a workspace
  // role must never reach the key that funds the whole organisation's usage.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Deciding who pays for tokens is governance, not AI usage — it consumes no
  // credits.
  noBillingGate: true,
  // The cross-field rules live on the schema, not only in the handler, so
  // every surface (API, MCP, the settings page's Server Action) refuses the
  // same malformed input with the same message before anything is encrypted.
  // The database CHECKs hold the same two pairings as a backstop.
  input: orgModelCredentialSetInputObject.superRefine((value, issues) => {
    const needsUrl = requiresCustomerBaseUrl(value.provider);
    if (needsUrl && !value.baseUrl) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "an OpenAI-compatible endpoint needs its base URL",
      });
    }
    // The range check lives here, not only in the handler, because a
    // refusal from the schema is `invalid_input` on every surface — a 400
    // with the reason — where the same throw from a handler is an
    // unclassified 500. `https://169.254.169.254/` passes the https check
    // on the field; this is what stops it.
    if (needsUrl && value.baseUrl) {
      try {
        assertPublicHttpUrl(value.baseUrl, {
          refusing: "Refusing to store model credential",
          requireTls: true,
        });
      } catch (err) {
        if (!(err instanceof UnsafeOutboundUrlError)) throw err;
        issues.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseUrl"],
          message: err.message,
        });
      }
    }
    if (!needsUrl && value.baseUrl) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: `a ${value.provider} key uses the vendor's own endpoint; remove the base URL`,
      });
    }
    // The balanced tier is what the assistant runs on, so it is the one a
    // direct-vendor key cannot work without. The other two fall back to
    // the platform id and fail loudly at the vendor if they are ever used.
    if (requiresModelMap(value.provider) && !value.modelMap?.balanced) {
      issues.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelMap", "balanced"],
        message:
          "a direct-vendor key needs the model it should use for the balanced tier",
      });
    }
  }),
  output: modelCredentialViewSchema,
});

export type OrgModelCredentialSetInput = z.output<
  typeof orgModelCredentialSet.input
>;
export type OrgModelCredentialSetOutput = z.output<
  typeof orgModelCredentialSet.output
>;
