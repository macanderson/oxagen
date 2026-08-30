import { z } from "zod";
import { registerCapability } from "../registry";
import { enforcementModeEnum } from "./schema.types";

export const schemaSetup = registerCapability({
  name: "setup_schema",
  domain: "schema",
  description:
    "Interactive LLM-assisted registry walkthrough: recommend → intent Q&A (run_schema_chat) → apply → activate.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"] as const,
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "schema" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    sampleLimit: z.number().int().min(1).max(5000).default(200).optional(),
    enforcement: enforcementModeEnum.optional(),
    noInteractive: z
      .boolean()
      .optional()
      .describe("Apply recommendation verbatim and activate"),
    json: z.boolean().optional(),
  }),
  output: z.object({
    schemasCreated: z.number(),
    labelsCreated: z.number(),
    relationshipTypesCreated: z.number(),
    pinnedVersionId: z.string().nullable(),
  }),
});

export type SchemaSetupInput = z.output<typeof schemaSetup.input>;
export type SchemaSetupOutput = z.output<typeof schemaSetup.output>;
