import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryRemove = registerCapability({
  name: "remove_plugin_registry",
  domain: "plugin",
  description:
    "Remove a workspace MCP registry source (including the default — removes the default and promotes the most-recently-created remaining registry, if any).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({ registryId: z.string() }),
  output: z.object({ ok: z.boolean(), promotedId: z.string().nullable() }),
});
