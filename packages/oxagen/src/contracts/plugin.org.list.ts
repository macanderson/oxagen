import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginOrgList = registerCapability({
  name: "list_plugins",
  domain: "plugin",
  description: "List installed plugins for this workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    pluginType: z
      .enum([
        "mcp_server",
        "integration",
        "agent_skill",
        "agent_capability",
        "knowledge_source",
      ])
      .optional(),
  }),
  output: z.object({
    listings: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        createdByUserId: z.string().nullable(),
        updatedByUserId: z.string().nullable(),
        deletedAt: z.string().nullable(),
        deletedByUserId: z.string().nullable(),
        orgId: z.string(),
        workspaceId: z.string(),
        pluginType: z.string(),
        source: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        iconUrl: z.string().nullable(),
        endpointUrl: z.string().nullable(),
        transport: z.string().nullable(),
        authKind: z.string(),
        authConfig: z.record(z.unknown()),
        enabled: z.boolean(),
        config: z.record(z.unknown()),
      }),
    ),
  }),
});
