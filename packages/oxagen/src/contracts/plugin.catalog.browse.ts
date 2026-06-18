import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogBrowse = registerCapability({
  name: "plugin.catalog.browse",
  domain: "plugin",
  description: "Search and filter the plugin marketplace by type, text, transport, and auth kind. Results are workspace-scoped — only registries enabled for the caller's org+workspace are queried.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    pluginType: z
      .enum(["mcp_server", "agent_capability", "agent_skill", "knowledge_source", "integration"])
      .optional(),
    search: z.string().optional(),
    categories: z.array(z.string()).optional(),
    transportTypes: z.array(z.string()).optional(),
    authKind: z.enum(["oauth", "secret", "none"]).optional(),
    // Filter by install status within the org+workspace scope:
    //   true  ⇒ only plugins already installed
    //   false ⇒ only plugins not yet installed
    //   omit  ⇒ all plugins (installed flag still returned per entry)
    installed: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(30),
    offset: z.number().int().min(0).default(0),
  }),
  output: z.object({
    servers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string().nullable(),
        description: z.string(),
        icons: z.array(z.object({ src: z.string() }).passthrough()),
        transportTypes: z.array(z.string()),
        authKind: z.string(),
        categories: z.array(z.string()),
        version: z.string(),
        pluginType: z.enum([
          "mcp_server",
          "agent_capability",
          "agent_skill",
          "knowledge_source",
          "integration",
        ]),
        // Present only for agent_capability entries from the static Oxagen registry:
        tier: z.enum(["free", "premium"]).optional(),
        installed: z.boolean(),
      }),
    ),
    nextOffset: z.number().nullable(),
    total: z.number(),
  }),
});
