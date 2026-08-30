import { z } from "zod";
import { registerCapability } from "../registry";

export const connectionMappingsSuggest = registerCapability({
  name: "suggest_connection_mappings",
  domain: "connection",
  description:
    "Use an LLM to suggest entity type mappings for a connection based on previewed record types. Part of the setup wizard flow.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "ai" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z.object({
    connectionId: z
      .string()
      .min(1)
      .describe("Public ID or internal UUID of the connection"),
    recordTypes: z
      .array(
        z.object({
          sourceRecordType: z.string(),
          displayName: z.string(),
          description: z.string().optional(),
          sampleFields: z.array(z.string()),
          sampleRecords: z.array(z.record(z.unknown())).optional(),
        }),
      )
      .describe(
        "Record type samples to analyze (from connection.preview output)",
      ),
    existingEntityTypes: z
      .array(z.string())
      .optional()
      .describe(
        "Entity types already defined in this workspace — helps the LLM reuse existing names",
      ),
  }),
  output: z.object({
    suggestions: z.array(
      z.object({
        sourceRecordType: z.string(),
        suggestedEntityType: z
          .string()
          .describe(
            "Recommended entity type string (snake_case, e.g. 'task', 'code_change')",
          ),
        suggestedPropertyMappings: z
          .record(z.string())
          .describe("Source field path → canonical property name mappings"),
        confidence: z.number().min(0).max(1),
        reasoning: z
          .string()
          .describe("LLM explanation shown to the user in the setup wizard"),
      }),
    ),
    suggestionIds: z
      .array(z.string())
      .describe("Public IDs of the persisted setup_suggestions rows"),
  }),
});

export type ConnectionMappingsSuggestInput = z.output<
  typeof connectionMappingsSuggest.input
>;
export type ConnectionMappingsSuggestOutput = z.output<
  typeof connectionMappingsSuggest.output
>;
