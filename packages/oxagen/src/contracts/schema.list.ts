import { z } from "zod";
import { registerCapability } from "../registry";
import { schemaSourceEnum } from "./schema.types";

export const schemaList = registerCapability({
  name: "list_schemas",
  domain: "schema",
  description: "List the workspace's schemas with per-schema enabled state.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({}),
  output: z.object({
    schemas: z.array(
      z.object({
        schemaName: z.string(),
        displayName: z.string(),
        source: schemaSourceEnum,
        connectorId: z.string().nullable().optional(),
        enabled: z.boolean(),
      }),
    ),
  }),
});

export type SchemaListInput = z.output<typeof schemaList.input>;
export type SchemaListOutput = z.output<typeof schemaList.output>;
