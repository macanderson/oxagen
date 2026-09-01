import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationGet = registerCapability({
  name: "get_integration",
  domain: "integration",
  description:
    "Get full details of a single plugin instance including schema and configuration.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
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
    id: z.string(),
    pluginId: z.string(),
    displayName: z.string(),
    version: z.string(),
    status: z.enum(["active", "paused", "failed", "pending_setup"]),
    config: z.record(z.unknown()),
    schema: z.record(z.unknown()).nullable(),
    entityCount: z.number(),
    lastSyncAt: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

export type IntegrationGetInput = z.output<typeof integrationGet.input>;
export type IntegrationGetOutput = z.output<typeof integrationGet.output>;
