import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginCatalogSync = registerCapability({
  name: "sync_plugin_catalog",
  domain: "plugin",
  description:
    "Trigger an immediate sync of the MCP registry catalog for the workspace. Refreshes the locally-cached server listings from the upstream registry.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit", "docs"],
  scoped: true,
  sensitivity: "low",
  noBillingGate: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    /** Force a full re-sync (ignore stored cursor). Default: false (incremental). */
    fullSync: z.boolean().default(false),
  }),
  output: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    totalEntries: z.number(),
    durationMs: z.number(),
  }),
});

export type PluginCatalogSyncInput = z.output<typeof pluginCatalogSync.input>;
export type PluginCatalogSyncOutput = z.output<typeof pluginCatalogSync.output>;
