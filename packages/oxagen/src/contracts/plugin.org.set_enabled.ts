import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginOrgSetEnabled = registerCapability({
  name: "plugin.org.set_enabled",
  domain: "plugin",
  description: "Toggle the enabled flag on a workspace plugin listing.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z.object({
    orgListingId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
