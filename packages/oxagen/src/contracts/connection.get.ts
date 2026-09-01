import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionGet = registerCapability({
  name: "get_connection",
  domain: "connection",
  description: "Get details of a single data source connection.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "medium",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    connectionId: z.string().min(1).describe("Public ID or internal UUID of the connection"),
  }),
  output: z.object({
    id: z.string(),
    publicId: z.string(),
    connectorId: z.string(),
    displayName: z.string(),
    authScheme: z.string(),
    deliveryMethod: z.string(),
    deliveryConfig: z.record(z.unknown()).nullable(),
    status: z.string(),
    entityCount: z.number(),
    lastSyncAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    // Poll/sync health rolled up by the connector poll loop.
    healthStatus: z.enum(["healthy", "degraded", "errored"]),
    consecutiveFailureCount: z.number(),
    lastPollAt: z.string().nullable(),
    nextPollAt: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

export type ConnectionGetInput = z.output<typeof connectionGet.input>;
export type ConnectionGetOutput = z.output<typeof connectionGet.output>;
