import { z } from "zod";
import { registerCapability } from "../registry";
import { FieldErrorSchema } from "./schema.shared";

export const schemaValidateNode = registerCapability({
  name: "validate_schema_node",
  domain: "schema",
  description:
    "Validate a node's properties against the workspace schema. Returns conformance score and field-level errors.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    label: z.string().min(1),
    properties: z.record(z.string(), z.unknown()),
    versionId: z.string().optional().describe("Defaults to pinned version"),
  }),
  output: z.object({
    valid: z.boolean(),
    conformanceScore: z.number().min(0).max(1),
    errors: z.array(FieldErrorSchema),
    missingRequired: z.array(z.string()),
    outcome: z.enum(["accepted", "rejected", "written_below_floor"]),
  }),
});

export type SchemaValidateNodeInput = z.output<typeof schemaValidateNode.input>;
export type SchemaValidateNodeOutput = z.output<
  typeof schemaValidateNode.output
>;
