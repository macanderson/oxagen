import { z } from "zod";
import { registerCapability } from "../registry";

export const schemaDelete = registerCapability({
  name: "delete_schema",
  domain: "schema",
  description:
    "Drop an entire named schema from the draft — its labels, relationship types, and properties.",
  mode: "sync",
  // Agent-surface only: schema.delete is invoked by the schema chat agent
  // (draft-state grounding), not yet exposed as an API route / MCP tool / CLI
  // command. Keep surfaces truthful so the MCP tool-registry parity guard holds.
  surfaces: ["agent"] as const,
  layers: ["schema", "docs"],
  scoped: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "schema" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    schemaName: z.string().min(1),
  }),
  output: z.object({
    deleted: z.boolean(),
    schemaName: z.string(),
    labelsRemoved: z.number(),
    relationshipTypesRemoved: z.number(),
  }),
});

export type SchemaDeleteInput = z.output<typeof schemaDelete.input>;
export type SchemaDeleteOutput = z.output<typeof schemaDelete.output>;
