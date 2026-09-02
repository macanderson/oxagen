import { z } from "zod";
import { registerCapability } from "../registry";
import {
  schemaSourceEnum,
  enforcementModeEnum,
  propertyInputSchema,
  cardinalityEnum,
} from "./schema.types";

export const schemaRegistryGet = registerCapability({
  name: "get_schema_registry",
  domain: "schema",
  description:
    "Resolve a workspace's registry: pinned version, draft version, enforcement mode, per-schema enabled state, label/relationship/property tree.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    versionId: z
      .string()
      .optional()
      .describe("Specific version to load; defaults to pinned"),
  }),
  output: z.object({
    registryId: z.string(),
    pinnedVersionId: z.string().nullable(),
    draftVersionId: z.string().nullable(),
    enforcementMode: enforcementModeEnum,
    conformanceFloor: z.number().min(0).max(1),
    schemas: z.array(
      z.object({
        schemaName: z.string(),
        displayName: z.string(),
        source: schemaSourceEnum,
        connectorId: z.string().optional(),
        enabled: z.boolean(),
        labels: z.array(
          z.object({
            name: z.string(),
            displayName: z.string(),
            description: z.string().nullable(),
            naturalKeyProps: z.array(z.string()),
            properties: z.array(propertyInputSchema),
          }),
        ),
        relationshipTypes: z.array(
          z.object({
            name: z.string(),
            displayName: z.string(),
            startLabel: z.string().nullable(),
            endLabel: z.string().nullable(),
            cardinality: cardinalityEnum.nullable(),
            properties: z.array(propertyInputSchema),
          }),
        ),
      }),
    ),
  }),
});

export type SchemaRegistryGetInput = z.output<typeof schemaRegistryGet.input>;
export type SchemaRegistryGetOutput = z.output<typeof schemaRegistryGet.output>;
