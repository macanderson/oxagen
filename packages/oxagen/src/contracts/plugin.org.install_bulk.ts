import { z } from "zod";
import { registerCapability } from "../registry";

const pluginTypeEnum = z.enum([
  "mcp_server",
  "integration",
  "agent_skill",
  "agent_capability",
  "knowledge_source",
]);

const installItemSchema = z.object({
  pluginType: pluginTypeEnum.default("mcp_server"),
  // Required when pluginType === "agent_capability"; validated in the handler.
  pluginId: z.string().optional(),
  catalogServerId: z.string().optional(),
  custom: z
    .object({
      name: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
      endpointUrl: z.string(),
      transport: z.string(),
      authKind: z.enum(["oauth", "secret", "none"]),
    })
    .optional(),
});

export const pluginOrgInstallBulk = registerCapability({
  name: "install_plugins_bulk",
  domain: "plugin",
  description:
    "Bulk install catalog or custom plugin servers to the org allow-list. Per-item errors are captured — not all-or-nothing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    items: z.array(installItemSchema).min(1).max(50),
  }),
  output: z.object({
    installed: z.array(
      z.object({
        // The plugin identifier for the item (capability pluginId, or null for
        // custom/registry servers). Mirrors what the handler returns and what
        // the app's installBulkPlugin action consumes — must stay in sync.
        pluginId: z.string().nullable(),
        orgListingId: z.string().nullable(),
        authKind: z.enum(["oauth", "secret", "none"]).nullable(),
        error: z.string().nullable(),
      }),
    ),
  }),
});
