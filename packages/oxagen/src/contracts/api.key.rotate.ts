import { z } from "zod";
import { registerCapability } from "../registry";

// Atomically issue a replacement API key and revoke the old one in a single
// transaction. The new key inherits the old key's scope, workspace, and expiry
// (name too, unless overridden). The raw replacement key is returned exactly
// once. Audited as api_key.created + api_key.revoked.
//
// Authorization: org Owner or Admin only.
export const apiKeyRotate = registerCapability({
  name: "rotate_api_key",
  domain: "api_key",
  description:
    "Atomically issue a replacement API key and revoke the old one. The replacement inherits the old key's scope/workspace/expiry and is returned once — never recoverable after this call. Audited as api_key.created + api_key.revoked.",
  mode: "sync",
  // "agent" is the surface the app's own token page invokes on
  // (apps/app/src/app/[orgSlug]/developer/tokens/api-key.ts), and the "app"
  // layer below already declares that page exists. Without it the kernel's
  // surface gate refused every rotate from the UI —
  // `Capability "rotate_api_key" is not exposed on the "agent" surface`.
  // ff4bbb233 widened create and left its two siblings behind; the handler
  // test calls the handler directly, so it never crossed the gate.
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // API key management does not consume AI tokens — billing gate must not block.
  noBillingGate: true,
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    keyPublicId: z
      .string()
      .min(1)
      .describe("The aky_* public ID of the API key to rotate"),
    name: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Optional new label for the replacement key (defaults to the old key's name)",
      ),
  }),
  output: z.object({
    keyId: z.string().describe("Internal UUID of the new key"),
    publicId: z
      .string()
      .describe("Prefixed public identifier of the new key (aky_ prefix)"),
    name: z.string(),
    keyPrefix: z
      .string()
      .describe("Short prefix of the new key, stored for index lookup"),
    rawKey: z
      .string()
      .describe("The full replacement API key — shown ONCE, never again"),
    expiresAt: z
      .string()
      .nullable()
      .describe("ISO-8601 expiry inherited from the old key, or null"),
    createdAt: z
      .string()
      .describe("ISO-8601 creation timestamp of the new key"),
    revokedKeyPublicId: z
      .string()
      .describe("Public ID of the now-revoked old key"),
    revokedAt: z
      .string()
      .describe("ISO-8601 timestamp the old key was revoked"),
  }),
});

export type ApiKeyRotateInput = z.output<typeof apiKeyRotate.input>;
export type ApiKeyRotateOutput = z.output<typeof apiKeyRotate.output>;
