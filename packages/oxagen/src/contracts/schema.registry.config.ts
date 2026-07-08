import { z } from "zod";
import { registerCapability } from "../registry";
import { enforcementModeEnum } from "./schema.types";

export const schemaRegistryConfig = registerCapability({
  name: "get_registry_config",
  aliases: ["schema.registry.config"],
  domain: "schema",
  description: "Set enforcement_mode and conformance_floor for the workspace registry.",
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

export type SchemaRegistryConfigInput = z.output<typeof schemaRegistryConfig.input>;
export type SchemaRegistryConfigOutput = z.output<typeof schemaRegistryConfig.output>;
