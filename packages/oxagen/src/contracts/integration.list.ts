import { z } from "zod";
import { registerCapability } from "../registry";

export const integrationList = registerCapability({
  name: "list_integrations",
  domain: "integration",
  description:
    "Browse installed plugin instances with status, config summary, and sync metrics.",
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
    status: z
      .enum(["active", "paused", "failed", "pending_setup"])
      .optional()
      .describe("Filter by status"),
    pluginId: z.string().optional().describe("Filter by plugin type"),
    limit: z.number().int().min(1).max(250).default(50),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    integrations: z.array(
      z.object({
        id: z.string(),
        pluginId: z.string(),
        displayName: z.string(),
        status: z.enum(["active", "paused", "failed", "pending_setup"]),
        version: z.string(),
        lastSyncAt: z.string().nullable(),
        entityCount: z.number(),
        errorMessage: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
    total: z.number(),
    hasMore: z.boolean(),
  }),
});

export type IntegrationListInput = z.output<typeof integrationList.input>;
export type IntegrationListOutput = z.output<typeof integrationList.output>;
