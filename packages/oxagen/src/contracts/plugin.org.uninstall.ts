import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginOrgUninstall = registerCapability({
  name: "plugin.org.uninstall",
  domain: "plugin",
  description: "Soft-delete a plugin listing from the org allow-list and remove all dependent workspace installs.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "high", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: false,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
