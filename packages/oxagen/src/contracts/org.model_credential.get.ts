import { z } from "zod";
import { registerCapability } from "../registry";
import { modelCredentialViewSchema } from "./org.model_credential.shared";

/**
 * get_model_credential — is a customer key stored for this organisation, and
 * which one (ADR-053 §2)?
 *
 * The output is DELIBERATELY redacted: provider, status, the last four
 * characters of the key, and the verification/rotation timestamps. A read that
 * echoed the key would turn every Owner/Admin token into a copy of the
 * customer's vendor credential. An operator who needs to change the key calls
 * set_model_credential; there is no read-back path by design.
 *
 * Organisation-level (`scoped: false`), like the mutation it mirrors.
 */
export const orgModelCredentialGet = registerCapability({
  name: "get_model_credential",
  domain: "org",
  description:
    "Read whether the organisation has stored its own model-vendor API key, and if so which provider, its status, the last four characters of the key, and when it was last verified and last rotated. Never returns the key.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "configuration",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Reading who pays for tokens is governance, not AI usage — it consumes no
  // credits.
  noBillingGate: true,
  input: z.object({}),
  output: modelCredentialViewSchema,
});

export type OrgModelCredentialGetInput = z.output<
  typeof orgModelCredentialGet.input
>;
export type OrgModelCredentialGetOutput = z.output<
  typeof orgModelCredentialGet.output
>;
