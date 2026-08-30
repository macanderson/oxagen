import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationDelete = registerCapability({
  name: "delete_integration",
  domain: "integration",
  description:
    "Remove a plugin instance and optionally purge its graph data from Neo4j.",
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    integrationId: z.string().describe("Plugin instance ID"),
    purgeData: z
      .boolean()
      .default(false)
      .describe(
        "Whether to delete all entities and edges from this plugin in Neo4j",
      ),
  }),
  output: z.object({
    jobId: z.string().describe("Background deletion job ID"),
    status: z.literal("queued"),
    integrationId: z.string(),
    purgeData: z.boolean(),
  }),
});

export type IntegrationDeleteInput = z.output<typeof integrationDelete.input>;
export type IntegrationDeleteOutput = z.output<typeof integrationDelete.output>;
