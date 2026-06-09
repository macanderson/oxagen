import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionMappingsSet = registerCapability({
  name: "connection.mappings.set",
  domain: "connection",
  description:
    "Save entity type mappings for a data source connection. Activates the connection and starts ingestion once mappings are confirmed.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "write" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    connectionId: z.string().min(1).describe("Public ID or internal UUID of the connection"),
    mappings: z
      .array(
        z.object({
          sourceRecordType: z.string().min(1),
          oxagenEntityType: z.string().min(1).describe("Target entity type string (snake_case)"),
          propertyMappings: z
            .record(z.string())
            .default({})
            .describe("Source field path → canonical property name"),
        }),
      )
      .min(1)
      .describe("Confirmed entity type mappings to save"),
    activateConnection: z
      .boolean()
      .default(true)
      .describe(
        "If true, sets connection status to active and queues initial sync after saving mappings",
      ),
  }),
  output: z.object({
    mappingsCreated: z.number(),
    mappingsUpdated: z.number(),
    connectionStatus: z.string(),
  }),
});

export type ConnectionMappingsSetInput = z.output<typeof connectionMappingsSet.input>;
export type ConnectionMappingsSetOutput = z.output<typeof connectionMappingsSet.output>;
