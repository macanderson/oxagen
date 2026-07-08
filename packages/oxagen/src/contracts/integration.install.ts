import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationInstall = registerCapability({
  name: "install_integration",
  domain: "integration",
  description:
    "Install a plugin instance from catalog or custom URL. Fetches schema, validates config, and installs in workspace scope.",
  mode: "async",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    pluginId: z.string().describe("Plugin identifier from catalog (e.g., 'github', 'google-drive')"),
    version: z.string().optional().describe("Plugin version (latest if omitted)"),
    schemaUrl: z
      .string()
      .url()
      .optional()
      .describe("For custom plugins: HTTPS URL to fetch schema.yaml from"),
    config: z.record(z.unknown()).describe("Plugin configuration matching the schema"),
    displayName: z.string().describe("Human-readable display name for this plugin instance"),
  }),
  output: z.object({
    jobId: z.string().describe("Background install job ID"),
    status: z.literal("queued"),
    pluginId: z.string(),
    displayName: z.string(),
  }),
});

export type IntegrationInstallInput = z.output<typeof integrationInstall.input>;
export type IntegrationInstallOutput = z.output<typeof integrationInstall.output>;
