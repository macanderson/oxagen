import { z } from "zod";
import { registerCapability } from "../registry";

// List the API keys in the caller's tenant scope. Each item carries the
// metadata the org's API keys page shows and nothing that could be exchanged
// for access: the raw key is returned once by create_api_key and never stored,
// and the stored SHA-256 hash stays in the row. The contract test walks the
// output schema and refuses any field named like a secret, a hash or a key.
//
// Revoked keys are included with their revokedAt so the page can show them;
// live keys carry revokedAt: null.
//
// Each item says whether rotate_api_key will replace it. The rotate handler
// refuses a key carrying a server-owned scope purpose, and both read the one
// list in packages/handlers/src/lib/api-key-purpose.ts, so a page cannot offer
// a rotation that is certain to be denied.
//
// Authorization: org Owner or Admin only, checked in the handler.
export const apiKeyList = registerCapability({
  name: "list_api_keys",
  domain: "api_key",
  description:
    "List the API keys in scope with their metadata: public id, name, prefix, creation, last use, expiry and revocation times. Never returns a key's secret or its hash.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  // A console read is never a governed action (ADR-052 exclusion 2).
  noBillingGate: true,
  sensitivity: "high",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({}),
  output: z.object({
    items: z.array(
      z.object({
        publicId: z.string().describe("Prefixed public identifier (aky_)"),
        name: z.string(),
        prefix: z
          .string()
          .describe("The fixed leading window of the raw key, for recognition"),
        createdAt: z.string().describe("ISO-8601 creation timestamp"),
        lastUsedAt: z
          .string()
          .nullable()
          .describe("ISO-8601 timestamp of the last request, or null"),
        expiresAt: z.string().nullable().describe("ISO-8601 expiry or null"),
        revokedAt: z
          .string()
          .nullable()
          .describe("ISO-8601 revocation timestamp, or null for a live key"),
        rotatable: z
          .boolean()
          .describe(
            "Whether rotate_api_key will replace this key. False for a key an enrollment or a login flow owns, whose lifecycle belongs to that service. Revocation is always available.",
          ),
      }),
    ),
  }),
});
