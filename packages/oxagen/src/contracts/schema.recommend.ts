import { z } from "zod";
import { registerCapability } from "../registry";
import { dataTypeEnum } from "./schema.types";

export const schemaRecommend = registerCapability({
  name: "recommend_schema",
  domain: "schema",
  description:
    "AI onboarding: read existing graph (get_graph_stats + graph_observed_labels ClickHouse telemetry + sampled query_ontology) and the workspace's enabled schemas → propose a starter schema or additions.",
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
  }),
  output: z.object({
    proposal: z.object({
      schemas: z.array(
        z.object({
          name: z.string(),
          displayName: z.string(),
          labels: z.array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              properties: z
                .array(
                  z.object({
                    key: z.string(),
                    dataType: dataTypeEnum,
                    required: z.boolean(),
                    description: z.string().optional(),
                  }),
                )
                .optional(),
            }),
          ),
          relationshipTypes: z.array(
            z.object({
              name: z.string(),
              startLabel: z.string().optional(),
              endLabel: z.string().optional(),
              description: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
    rationale: z.string(),
    sampledCount: z.number().int(),
  }),
});

export type SchemaRecommendInput = z.output<typeof schemaRecommend.input>;
export type SchemaRecommendOutput = z.output<typeof schemaRecommend.output>;
