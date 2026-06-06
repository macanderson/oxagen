import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistryList = registerCapability({
  name: "plugin.registry.list",
  domain: "plugin",
  description: "List MCP registries available to the org (global default seed + org-added).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}),
  output: z.object({
    registries: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        baseUrl: z.string(),
        enabled: z.boolean(),
        isDefaultSeed: z.boolean(),
        lastSyncedAt: z.string().nullable(),
      }),
    ),
  }),
});
