import { z } from "zod";
import { registerCapability } from "../registry";
import { enforcementModeEnum } from "./schema.types";

// NOTE: this is a WRITE despite the `get_` prefix — it is mounted at
// `PUT /schema/registry/config` and updates enforcement_mode /
// conformance_floor. The name is load-bearing (registry key, API route
// dispatch, MCP tool id, handler registration), so renaming it to
// `set_registry_config` is a coordinated cross-surface change, not a local edit.
export const schemaRegistryConfig = registerCapability({
  name: "get_registry_config",
  domain: "schema",
  description:
    "Set enforcement_mode and conformance_floor for the workspace registry.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    enforcementMode: enforcementModeEnum.optional(),
    conformanceFloor: z.number().min(0).max(1).optional(),
  }),
  output: z.object({
    registryId: z.string(),
    enforcementMode: enforcementModeEnum,
    conformanceFloor: z.number(),
  }),
});

export type SchemaRegistryConfigInput = z.output<
  typeof schemaRegistryConfig.input
>;
export type SchemaRegistryConfigOutput = z.output<
  typeof schemaRegistryConfig.output
>;
