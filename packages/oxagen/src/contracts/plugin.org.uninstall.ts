import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginOrgUninstall = registerCapability({
  name: "uninstall_plugin",
  domain: "plugin",
  description:
    "Soft-delete a plugin listing from this workspace and remove all dependent MCP server rows.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    orgListingId: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
