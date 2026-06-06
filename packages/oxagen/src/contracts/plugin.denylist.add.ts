import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginDenylistAdd = registerCapability({
  name: "plugin.denylist.add",
  domain: "plugin",
  description: "Add a plugin server name to the org denylist. Immediately disables and removes any matching org listings and workspace installs.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({
    pluginType: z.enum(["mcp_server", "integration", "content_tool"]).default("mcp_server"),
    serverName: z.string(),
    reason: z.string().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
  }),
});
