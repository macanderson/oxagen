import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationConfigure = registerCapability({
  name: "configure_integration",
  domain: "integration",
  description:
    "Update plugin instance configuration: credentials, filters, and sync cadence.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
    displayName: z.string().optional().describe("Update display name"),
    config: z.record(z.unknown()).optional().describe("Updated config fields"),
    syncCadence: z
      .enum(["manual", "polling", "webhook"])
      .optional()
      .describe("Update sync trigger method"),
  }),
  output: z.object({
    integrationId: z.string(),
    displayName: z.string(),
    syncCadence: z.enum(["manual", "polling", "webhook"]),
    updatedAt: z.string(),
  }),
});

export type IntegrationConfigureInput = z.output<
  typeof integrationConfigure.input
>;
export type IntegrationConfigureOutput = z.output<
  typeof integrationConfigure.output
>;
