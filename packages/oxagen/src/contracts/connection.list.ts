import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionList = registerCapability({
  name: "list_connections",
  domain: "connection",
  description: "List all data source connections for a workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    status: z
      .enum([
        "pending_setup",
        "connected",
        "paused",
        "error",
        "deleting",
        "deleted",
      ])
      .optional()
      .describe("Filter by connection status"),
    connectorId: z
      .string()
      .optional()
      .describe("Filter by connector type slug"),
  }),
  output: z.object({
    connections: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        connectorId: z.string(),
        displayName: z.string(),
        authScheme: z.string(),
        deliveryMethod: z.string(),
        status: z.string(),
        entityCount: z.number(),
        lastSyncAt: z.string().nullable(),
        // Poll/sync health rolled up by the connector poll loop.
        healthStatus: z.enum(["healthy", "degraded", "errored"]),
        lastPollAt: z.string().nullable(),
        nextPollAt: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
});

export type ConnectionListInput = z.output<typeof connectionList.input>;
export type ConnectionListOutput = z.output<typeof connectionList.output>;
