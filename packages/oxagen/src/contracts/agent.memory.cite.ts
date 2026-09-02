import { z } from "zod";
import { registerCapability } from "../registry";
import { influenceEnum } from "./agent.memory.model";

/**
 * agent.memory.cite — record that an execution retrieved and used memories
 * (schema §6). Captures the counterfactual: did each memory shape the output,
 * and for rules, was it complied with given its enforcement. Merges the
 * :Execution, writes a :Citation per memory, and maintains the citation /
 * influence / violation counters. Compliance is derived server-side from the
 * memory's enforcement, the `deviated` flag, and the workspace compliance
 * threshold.
 */
export const agentMemoryCite = registerCapability({
  name: "cite_memory",
  domain: "agent",
  description:
    "Record citations of memories within an agent execution — influence and rule-compliance — and update citation/influence/violation counters.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    executionRef: z
      .string()
      .min(1)
      .describe(
        "Execution id to attach citations to; created (MERGE) if absent",
      ),
    agentId: z.string().optional(),
    runId: z.string().optional(),
    taskSummary: z.string().max(500).optional(),
    citations: z
      .array(
        z.object({
          memoryId: z.string().min(1),
          influence: influenceEnum,
          deviated: z
            .boolean()
            .default(false)
            .describe(
              "true when the output departed from the memory's expected value",
            ),
          expectedValue: z.string().max(500).optional(),
          observedValue: z.string().max(500).optional(),
          agentRationale: z.string().max(1000).optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
  output: z.object({
    executionId: z.string(),
    results: z.array(
      z.object({
        memoryId: z.string(),
        ok: z.boolean(),
        citationId: z.string().nullable(),
        compliance: z.enum(["COMPLIED", "DISCRETION", "VIOLATION", "NA"]),
        error: z.string().nullable(),
      }),
    ),
    recorded: z.number().int().nonnegative(),
  }),
});

export type AgentMemoryCiteInput = z.output<typeof agentMemoryCite.input>;
export type AgentMemoryCiteOutput = z.output<typeof agentMemoryCite.output>;
