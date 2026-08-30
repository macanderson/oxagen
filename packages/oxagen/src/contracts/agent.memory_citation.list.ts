import { z } from "zod";
import { registerCapability } from "../registry";
import { complianceEnum, influenceEnum } from "./agent.memory.model";

/**
 * agent.memory.citations.list — list the memory citations recorded for an
 * execution (schema §7d/§7e). Filter by compliance (e.g. VIOLATION — which rules
 * were broken) or influence (e.g. DECISIVE/CONTRIBUTING — what actually shaped
 * the output). Feeds future evals; here it is the read side of the mechanism.
 */
export const agentMemoryCitationsList = registerCapability({
  name: "list_memory_citations",
  domain: "agent",
  description:
    "List memory citations for an execution, optionally filtered by compliance (violations) or influence (what shaped the output).",
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
    executionId: z.string().min(1),
    compliance: complianceEnum
      .optional()
      .describe("Filter to a single compliance outcome (e.g. VIOLATION)"),
    influenceIn: z
      .array(influenceEnum)
      .optional()
      .describe(
        "Filter to these influence levels (e.g. [DECISIVE, CONTRIBUTING])",
      ),
  }),
  output: z.object({
    citations: z.array(
      z.object({
        citationId: z.string(),
        memoryId: z.string(),
        lesson: z.string(),
        influence: influenceEnum,
        compliance: complianceEnum,
        enforcementAtCite: z.number().int().nullable(),
        expectedValue: z.string().nullable(),
        observedValue: z.string().nullable(),
        agentRationale: z.string().nullable(),
      }),
    ),
  }),
});

export type AgentMemoryCitationsListInput = z.output<
  typeof agentMemoryCitationsList.input
>;
export type AgentMemoryCitationsListOutput = z.output<
  typeof agentMemoryCitationsList.output
>;
