import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaLabelDelete = registerCapability({
  name: "delete_schema_label",
  aliases: ["schema.label.delete"],
  domain: "schema",
  description: "Remove a node label and its properties from the draft.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    schemaName: z.string().min(1),
    name: z.string().min(1),
  }),
  output: z.object({
    deleted: z.boolean(),
    labelName: z.string(),
  }),
});

export type SchemaLabelDeleteInput = z.output<typeof schemaLabelDelete.input>;
export type SchemaLabelDeleteOutput = z.output<typeof schemaLabelDelete.output>;
