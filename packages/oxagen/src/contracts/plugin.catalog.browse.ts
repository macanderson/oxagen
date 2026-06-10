import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogBrowse = registerCapability({
  name: "plugin.catalog.browse",
  domain: "plugin",
  description: "Search and filter the MCP server catalog (latest versions) by text, category, transport, and auth kind.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    pluginType: z.enum(["mcp_server", "integration", "content_tool"]).optional(),
    search: z.string().optional(),
    categories: z.array(z.string()).optional(),
    transportTypes: z.array(z.string()).optional(),
    authKind: z.enum(["oauth", "secret", "none"]).optional(),
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
        pluginType: z.enum(["mcp_server", "integration", "content_tool"]),
      }),
    ),
    nextOffset: z.number().nullable(),
    total: z.number(),
  }),
});
