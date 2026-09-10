import { z } from "zod";
import { registerCapability } from "../registry";
import {
  modelCredentialApiKeySchema,
  modelCredentialProviderSchema,
  modelCredentialVerificationSchema,
} from "./org.model_credential.shared";

/**
 * The BASE object of the input, exported separately because the registered
 * `input` is a ZodEffects (superRefine) and therefore has no `.shape`. The MCP
 * tool builds its parameter schema from this object; `invoke()` re-parses the
 * full refined contract input, so the pairing rule below applies on every
 * surface.
 */
export const orgModelCredentialVerifyInputObject = z.object({
  /**
   * A candidate key to check before storing it. Omit both fields to verify
   * the key already stored for the organisation.
   */
  provider: modelCredentialProviderSchema.optional(),
  apiKey: modelCredentialApiKeySchema.optional(),
});

/**
 * One cross-field rule the object alone cannot express: a candidate key and
 * its provider travel together. A key with no provider cannot be checked
 * against anything, and a provider with no key would silently verify the
 * stored key under a possibly different provider and report the wrong thing.
 */
const orgModelCredentialVerifyInput =
  orgModelCredentialVerifyInputObject.superRefine((value, ctx) => {
    const hasProvider = value.provider !== undefined;
    const hasKey = value.apiKey !== undefined;
    if (hasProvider !== hasKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [hasProvider ? "apiKey" : "provider"],
        message:
          "provider and apiKey must be given together to verify a candidate key, or both omitted to verify the stored key",
      });
    }
  });

/**
 * verify_model_credential — ask the vendor whether a key is accepted
 * (ADR-053 §2).
 *
 * The check is a metadata read on the vendor's own key endpoint and spends no
 * tokens. With a candidate key it verifies before anything is stored, which
 * is what the settings page calls from its "Test key" button; with no input
 * it verifies the stored key and stamps `last_verified_at` on success, which
 * is what a health sweep calls.
 *
 * A refusal is reported, not thrown: the vendor's message about the key is
 * the output the operator needs to fix it. Nothing here writes a key, so it
 * emits no security event.
 */
export const orgModelCredentialVerify = registerCapability({
  name: "verify_model_credential",
  domain: "org",
  description:
    "Check a model-vendor API key against the vendor without spending tokens. Pass provider and apiKey to test a candidate before storing it, or nothing to test the organisation's stored key. Reports whether the vendor accepted it and, if not, the vendor's reason.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  input: orgModelCredentialVerifyInput,
  output: modelCredentialVerificationSchema,
});

export type OrgModelCredentialVerifyInput = z.output<
  typeof orgModelCredentialVerify.input
>;
export type OrgModelCredentialVerifyOutput = z.output<
  typeof orgModelCredentialVerify.output
>;
