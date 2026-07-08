import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationSync = registerCapability({
  name: "sync_integration",
  aliases: ["integration.sync"],
  domain: "integration",
  description: "Trigger synchronization of a plugin instance.",
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "medium", category: "plugin" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    integrationId: z.string().describe("Plugin instance ID"),
    mode: z
      .enum(["incremental", "full"])
      .default("incremental")
      .describe("Sync mode: incremental (since last cursor) or full"),
  }),
  output: z.object({
    jobId: z.string().describe("Background sync job ID"),
    status: z.literal("queued"),
    integrationId: z.string(),
    mode: z.enum(["incremental", "full"]),
  }),
});

export type IntegrationSyncInput = z.output<typeof integrationSync.input>;
export type IntegrationSyncOutput = z.output<typeof integrationSync.output>;
