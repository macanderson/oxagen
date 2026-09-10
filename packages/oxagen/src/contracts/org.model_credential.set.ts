import { z } from "zod";
import { registerCapability } from "../registry";
import {
  modelCredentialApiKeySchema,
  modelCredentialProviderSchema,
  modelCredentialViewSchema,
} from "./org.model_credential.shared";

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
    "Store the organisation's own model-vendor API key (OpenRouter or Vercel AI Gateway). While a key is stored, the in-app agent's completions run on it and Oxagen bills nothing for those tokens. The key is envelope-encrypted at rest and never readable back. Replaces any key already stored. Returns the redacted credential view.",
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
  input: z.object({
    provider: modelCredentialProviderSchema,
    apiKey: modelCredentialApiKeySchema,
  }),
  output: modelCredentialViewSchema,
});

export type OrgModelCredentialSetInput = z.output<
  typeof orgModelCredentialSet.input
>;
export type OrgModelCredentialSetOutput = z.output<
  typeof orgModelCredentialSet.output
>;
