import { z } from "zod";
import { registerCapability } from "../registry";
import { modelCredentialViewSchema } from "./org.model_credential.shared";

/**
 * delete_model_credential — remove the organisation's stored key and return
 * it to the platform key (ADR-053 §2).
 *
 * From the next turn on, completions run on Oxagen's key and their tokens are
 * billed as assistant usage under the organisation's spend cap (ADR-053 §3).
 * The ciphertext row is soft-deleted, so the audit trail keeps that a key
 * existed and when it went, without keeping the envelope live.
 *
 * Idempotent: deleting when nothing is stored is not an error, because the
 * state the caller asked for is the state they have. Audited as a
 * `model_credential.revoked` security event only when a key was actually
 * removed.
 *
 * No `agent` metadata on purpose, for the same reason as set_model_credential:
 * the in-app agent must not be able to move its own turns onto the platform
 * key.
 */
export const orgModelCredentialDelete = registerCapability({
  name: "delete_model_credential",
  domain: "org",
  description:
    "Remove the organisation's stored model-vendor API key. From the next turn on, the in-app agent runs on the platform key and its tokens are billed as assistant usage. Idempotent when no key is stored. Returns the redacted credential view.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: z.object({}),
  output: modelCredentialViewSchema,
});

export type OrgModelCredentialDeleteInput = z.output<
  typeof orgModelCredentialDelete.input
>;
export type OrgModelCredentialDeleteOutput = z.output<
  typeof orgModelCredentialDelete.output
>;
