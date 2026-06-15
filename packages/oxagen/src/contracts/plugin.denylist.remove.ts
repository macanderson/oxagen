import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginDenylistRemove = registerCapability({
  name: "plugin.denylist.remove",
  domain: "plugin",
  description: "Remove a plugin server name from the org denylist, re-allowing installation.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: true, riskLevel: "medium", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit"],
  scoped: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    serverName: z.string(),
    pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
