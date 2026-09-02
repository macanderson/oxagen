import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionCreate = registerCapability({
  name: "create_connection",
  domain: "connection",
  description:
    "Create a new data source connection for a workspace. Credentials are encrypted before storage.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "write" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    connectorId: z
      .string()
      .min(1)
      .describe("Connector type slug (e.g. 'github', 'google-drive')"),
    displayName: z
      .string()
      .min(1)
      .max(255)
      .describe("Human-readable name for this connection"),
    connectionConfig: z
      .record(z.unknown())
      .optional()
      .describe("Connector-specific configuration"),
    authCredential: z
      .record(z.unknown())
      .describe("Auth credential object — encrypted before storage"),
    deliveryMethod: z
      .string()
      .optional()
      .describe("Override delivery method (defaults to connector default)"),
  }),
  output: z.object({
    connectionId: z
      .string()
      .describe("Internal UUID of the source_connections row"),
    publicId: z.string().describe("con_* prefixed public ID"),
    status: z.literal("pending_setup"),
    connectorId: z.string(),
    displayName: z.string(),
  }),
});

export type ConnectionCreateInput = z.output<typeof connectionCreate.input>;
export type ConnectionCreateOutput = z.output<typeof connectionCreate.output>;
