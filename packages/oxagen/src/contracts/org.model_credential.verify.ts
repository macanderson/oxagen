import { z } from "zod";
import {
  assertPublicHttpUrl,
  UnsafeOutboundUrlError,
} from "@oxagen/config/public-url";
import { registerCapability } from "../registry";
import {
  modelCredentialApiKeySchema,
  modelCredentialBaseUrlSchema,
  modelCredentialProviderSchema,
  modelCredentialVerificationSchema,
  requiresCustomerBaseUrl,
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
  /** The candidate's endpoint, for an `openai_compatible` candidate only. */
  baseUrl: modelCredentialBaseUrlSchema.nullish(),
  /**
   * The model to ask the tool-calling question of — the one the organisation
   * will map to the balanced tier. Consulted only for `openai_compatible`;
   * the other providers are known to call tools and are not asked.
   */
  toolProbeModel: z.string().min(1).max(200).nullish(),
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
    // A candidate endpoint is probed WITH the candidate key attached, so it
    // gets the same range check the set path gives it — before the probe
    // runs, not after. Without this, verify is an SSRF: point it at the
    // metadata address and read back whatever the vendor-message path echoes.
    if (value.provider && requiresCustomerBaseUrl(value.provider)) {
      if (!value.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseUrl"],
          message: "an OpenAI-compatible endpoint needs its base URL",
        });
        return;
      }
      try {
        assertPublicHttpUrl(value.baseUrl, {
          refusing: "Refusing to verify model credential",
          requireTls: true,
        });
      } catch (err) {
        if (!(err instanceof UnsafeOutboundUrlError)) throw err;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseUrl"],
          message: err.message,
        });
      }
    }
  });

/**
 * verify_model_credential — ask the vendor whether a key is accepted
 * (ADR-053 §2).
 *
 * The check is a metadata read on the vendor's own key endpoint, which spends
 * nothing — plus, for an `openai_compatible` endpoint, one forced tool call of
 * at most 16 tokens, because a key that authenticates on a model that cannot
 * call tools is not a working assistant. With a candidate key it verifies before anything is stored, which
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
    "Check a model-vendor API key against the vendor. Pass provider and apiKey (and baseUrl plus toolProbeModel for an OpenAI-compatible endpoint) to test a candidate before storing it, or nothing to test the organisation's stored key. Reports whether the vendor accepted it, whether the endpoint can call tools, and the vendor's reason when either fails. Free for the named vendors; an OpenAI-compatible endpoint is asked one forced tool call of at most 16 tokens.",
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
