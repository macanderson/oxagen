import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginWorkspaceSetEnabled = registerCapability({
  name: "plugin.workspace.set_enabled",
  domain: "plugin",
  description: "Enable or disable a plugin server for this workspace. Enabling upserts an agent.mcp_servers row from the org listing (marketplace install path); disabling sets it to disabled.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    orgListingId: z.string(),
    enabled: z.boolean(),
  }),
  output: z.object({
    workspaceServerId: z.string().nullable(),
  }),
});
