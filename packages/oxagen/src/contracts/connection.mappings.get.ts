import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionMappingsGet = registerCapability({
  name: "get_connection_mappings",
  domain: "connection",
  description: "Get the current entity type mappings for a data source connection.",
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
    mappings: z.array(
      z.object({
        id: z.string(),
        sourceRecordType: z.string(),
        oxagenEntityType: z.string(),
        propertyMappings: z.record(z.string()),
        isActive: z.boolean(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
});

export type ConnectionMappingsGetInput = z.output<typeof connectionMappingsGet.input>;
export type ConnectionMappingsGetOutput = z.output<typeof connectionMappingsGet.output>;
