import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryRemove = registerCapability({
  name: "plugin.registry.remove",
  domain: "plugin",
  description: "Remove an org-added MCP registry source (the global default seed cannot be removed).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string() }),
  output: z.object({ ok: z.boolean() }),
});
