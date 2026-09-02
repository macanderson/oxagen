import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationMetrics = registerCapability({
  name: "get_integration_metrics",
  domain: "integration",
  description: "Get sync statistics and metrics for a plugin instance.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    integrationId: z.string().describe("Plugin instance ID"),
  }),
  output: z.object({
    integrationId: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    status: z.enum(["active", "paused", "failed", "pending_setup"]),
    entityCount: z.number(),
    entityCountByType: z.record(z.number()),
    lastSyncAt: z.string().nullable(),
    lastSyncDurationMs: z.number().nullable(),
    lastErrorAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
  }),
});

export type IntegrationMetricsInput = z.output<typeof integrationMetrics.input>;
export type IntegrationMetricsOutput = z.output<
  typeof integrationMetrics.output
>;
