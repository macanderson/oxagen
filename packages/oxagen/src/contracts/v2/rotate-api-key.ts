import { z } from "zod";
import { defineTool } from "./_define";
import { apiKeyRotate } from "../api.key.rotate";

/**
 * Appendix E: `rotate_api_key` — absorbs `rotate_api_key`. The Does column is
 * blank, which for this row means the job is unchanged: atomically issue a
 * replacement and revoke the old key in one transaction.
 *
 * A clean 1:1 carry. Everything is taken by reference, including the two
 * properties that are easy to lose in a retype and expensive to lose in
 * production: the replacement INHERITS the old key's scope, workspace and
 * expiry (so rotating does not quietly extend a key's life), and the raw
 * replacement is returned exactly once.
 *
 * `purpose` is deliberately not an input here even though `create_api_key`
 * gained one. §6.2 locks a credential to one purpose; a rotation that could
 * change it would be a new key wearing an old key's identity, and the four
 * inheritance guarantees above would no longer describe what came back.
 *
 * The surface list carries as-is, including `agent`. Its comment in the source
 * records a real outage: the app's own token page invokes on the agent surface,
 * and omitting it made the kernel refuse every rotation from the UI with
 * `Capability "rotate_api_key" is not exposed on the "agent" surface`, while
 * the handler test kept passing because it called the handler directly.
 */
export const rotateApiKey = defineTool({
  name: "rotate_api_key",
  domain: "api_key",
  description:
    "Atomically issue a replacement API key and revoke the old one. The replacement inherits the old key's purpose, scope, workspace and expiry, and is returned once — never recoverable after this call. Audited as api_key.created + api_key.revoked.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,

  absorbs: ["rotate_api_key"],
  drops: [],

  // Carried unchanged. Stricter than `create_api_key` on approval and risk, and
  // rightly so: creating a key adds an entry, rotating invalidates one that
  // callers in the wild are still using.
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
  noBillingGate: true,
  mutates: true,

  input: z.object({
    keyPublicId: apiKeyRotate.input.shape.keyPublicId,
    name: apiKeyRotate.input.shape.name,
  }),

  output: z.object({
    keyId: apiKeyRotate.output.shape.keyId,
    publicId: apiKeyRotate.output.shape.publicId,
    name: apiKeyRotate.output.shape.name,
    keyPrefix: apiKeyRotate.output.shape.keyPrefix,
    rawKey: apiKeyRotate.output.shape.rawKey,
    expiresAt: apiKeyRotate.output.shape.expiresAt,
    createdAt: apiKeyRotate.output.shape.createdAt,
    revokedKeyPublicId: apiKeyRotate.output.shape.revokedKeyPublicId,
    revokedAt: apiKeyRotate.output.shape.revokedAt,
  }),
});

export type RotateApiKeyInput = z.output<typeof rotateApiKey.input>;
export type RotateApiKeyOutput = z.output<typeof rotateApiKey.output>;
