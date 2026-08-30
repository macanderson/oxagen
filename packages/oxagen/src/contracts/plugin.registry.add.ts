import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryAdd = registerCapability({
  name: "add_plugin_registry",
  domain: "plugin",
  description:
    "Add an MCP registry source for the workspace (any registry implementing the MCP Registry OpenAPI).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    name: z.string().min(1).max(120),
    baseUrl: z.string().url(),
  }),
  output: z.object({ registryId: z.string(), isDefault: z.boolean() }),
});
