import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaVersionDiff = registerCapability({
  name: "diff_schema_versions",
  domain: "schema",
  description:
    "Structural diff of two versions: added/removed/changed schemas, labels, relationship types, properties.",
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
    fromVersionId: z.string().min(1),
    toVersionId: z.string().min(1),
  }),
  output: z.object({
    schemasAdded: z.array(z.string()),
    schemasRemoved: z.array(z.string()),
    labelsAdded: z.array(
      z.object({ schemaName: z.string(), labelName: z.string() }),
    ),
    labelsRemoved: z.array(
      z.object({ schemaName: z.string(), labelName: z.string() }),
    ),
    labelsChanged: z.array(
      z.object({
        schemaName: z.string(),
        labelName: z.string(),
        changes: z.array(z.string()),
      }),
    ),
    relationshipTypesAdded: z.array(
      z.object({ schemaName: z.string(), relationshipTypeName: z.string() }),
    ),
    relationshipTypesRemoved: z.array(
      z.object({ schemaName: z.string(), relationshipTypeName: z.string() }),
    ),
    relationshipTypesChanged: z.array(
      z.object({
        schemaName: z.string(),
        relationshipTypeName: z.string(),
        changes: z.array(z.string()),
      }),
    ),
    propertiesAdded: z.array(
      z.object({ ownerName: z.string(), key: z.string() }),
    ),
    propertiesRemoved: z.array(
      z.object({ ownerName: z.string(), key: z.string() }),
    ),
    propertiesChanged: z.array(
      z.object({
        ownerName: z.string(),
        key: z.string(),
        changes: z.array(z.string()),
      }),
    ),
  }),
});

export type SchemaVersionDiffInput = z.output<typeof schemaVersionDiff.input>;
export type SchemaVersionDiffOutput = z.output<typeof schemaVersionDiff.output>;
