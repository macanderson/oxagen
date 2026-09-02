import { z } from "zod";
import { registerCapability } from "../registry";

export const skillMetricsRead = registerCapability({
  name: "get_skill_metrics",
  domain: "skill",
  description:
    "Read aggregated skill usage and cost metrics for the workspace. Returns load counts, last-used timestamps, approximate token cost (best-effort via join to token_usage on execution_step_id — multi-skill attribution is partial), and per-version load breakdown. Omit skillId for workspace-wide aggregation.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "docs", "mcp", "app"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "skill" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow", Member: "allow" },
  },
  input: z.object({
    skillId: z
      .string()
      .optional()
      .describe(
        "Public ID of a specific skill (omit for workspace-wide aggregation)",
      ),
  }),
  output: z.object({
    skills: z.array(
      z.object({
        skillId: z.string().describe("Public ID of the skill"),
        slug: z.string().describe("Slug identifier for the skill"),
        activeVersion: z
          .number()
          .nullable()
          .describe("Currently active version number"),
        usageCount: z
          .number()
          .describe(
            "Total recorded invocations from Postgres (fast-path denormalized column)",
          ),
        lastUsedAt: z
          .string()
          .nullable()
          .describe("ISO-8601 timestamp of last recorded load from Postgres"),
        approxTokenCost: z
          .number()
          .nullable()
          .describe(
            "Approximate total token cost in USD cents across all loads. Best-effort — multi-skill runs attribute cost to all loaded skills so sums may exceed actual spend.",
          ),
        perVersionLoads: z.array(
          z.object({
            version: z.number(),
            loads: z.number(),
            lastUsed: z.string().nullable(),
          }),
        ),
      }),
    ),
  }),
});

export type SkillMetricsReadInput = z.output<typeof skillMetricsRead.input>;
export type SkillMetricsReadOutput = z.output<typeof skillMetricsRead.output>;
