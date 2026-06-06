import { z } from "zod";
import { registerCapability } from "../registry";

export const pluginRegistrySync = registerCapability({
  name: "plugin.registry.sync",
  domain: "plugin",
  description: "Trigger an on-demand catalog sync for a registry (async; returns accepted).",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  agent: { requiresApproval: false, riskLevel: "low", category: "plugin" },
  layers: ["api", "mcp", "unit"],
  scoped: false,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({ registryId: z.string(), mode: z.enum(["full", "incremental"]).default("incremental") }),
  output: z.object({ accepted: z.boolean() }),
});
