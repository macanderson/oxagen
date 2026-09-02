import { z } from "zod";
import { registerCapability } from "../registry";

// Render directive schema (mirrors RenderDirective in stream-event-types)
const renderDirectiveSchema = z.object({
  componentId: z.string(),
  props: z.record(z.unknown()),
});

// Create a new API key scoped to the requesting org. The raw key is returned
// exactly once (on creation) and is never stored in plaintext — only the SHA-256
// hash and the short prefix are persisted. Callers must save the raw key
// immediately; it cannot be retrieved later. Audited as api_key.created.
//
// Authorization: org Owner or Admin only.
export const apiKeyCreate = registerCapability({
  name: "create_api_key",
  domain: "api_key",
  description:
    "Create a new API key for the org. Returns the raw key once — it is never recoverable after this call. Audited as api_key.created.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // API key management does not consume AI tokens — billing gate must not
  // block this for orgs with zero credit balance.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "organization",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(120)
      .describe("Human-readable label for the key"),
    scope: z
      .record(z.unknown())
      .optional()
      .default({})
      .describe("Optional scope constraints (reserved for future use)"),
    expiresAt: z
      .string()
      .datetime()
      .optional()
      .describe(
        "Optional ISO-8601 expiry timestamp. Omit for a non-expiring key.",
      ),
  }),
  output: z.object({
    keyId: z.string().describe("Internal UUID of the created key"),
    publicId: z.string().describe("Prefixed public identifier (aky_ prefix)"),
    name: z.string(),
    keyPrefix: z.string().describe("Short prefix stored for index lookup"),
    rawKey: z.string().describe("The full API key — shown ONCE, never again"),
    expiresAt: z.string().nullable().describe("ISO-8601 expiry or null"),
    createdAt: z.string().describe("ISO-8601 creation timestamp"),
    render: renderDirectiveSchema
      .optional()
      .describe(
        "Render directive for displaying the key in the chat UI (agent surface only)",
      ),
  }),
});

export type ApiKeyCreateInput = z.output<typeof apiKeyCreate.input>;
export type ApiKeyCreateOutput = z.output<typeof apiKeyCreate.output>;
