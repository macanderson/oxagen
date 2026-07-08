import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationConfigure = registerCapability({
  name: "integration.configure",
  domain: "integration",
  description: "Update plugin instance config: credentials, sync cadence, inference toggles, ontology prompts.",
  mode: "sync",
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
    displayName: z.string().optional().describe("Update display name"),
    config: z.record(z.unknown()).optional().describe("Updated config fields"),
    syncCadence: z
      .enum(["manual", "polling", "webhook"])
      .optional()
      .describe("Update sync trigger method"),
    inferenceEnabled: z.boolean().optional().describe("Enable/disable LLM inference"),
    ontologyPrompt: z
      .string()
      .optional()
      .describe("Custom prompt for entity extraction from this source"),
    semanticEdgePrompt: z
      .string()
      .optional()
      .describe("Custom prompt for cross-source relationship inference"),
  }),
  output: z.object({
    integrationId: z.string(),
    displayName: z.string(),
    syncCadence: z.enum(["manual", "polling", "webhook"]),
    inferenceEnabled: z.boolean(),
    updatedAt: z.string(),
  }),
});

export type IntegrationConfigureInput = z.output<typeof integrationConfigure.input>;
export type IntegrationConfigureOutput = z.output<typeof integrationConfigure.output>;
