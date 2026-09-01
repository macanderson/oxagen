import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryList = registerCapability({
  name: "list_plugin_registries",
  domain: "plugin",
  description: "List MCP registries for the workspace.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}),
  output: z.object({
    registries: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseUrl: z.string(),
        enabled: z.boolean(),
        isDefault: z.boolean(),
      }),
    ),
  }),
});
