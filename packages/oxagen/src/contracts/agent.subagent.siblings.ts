import { z } from "zod";
import { registerCapability } from "../registry";

// Tier A of Phase 2 graph-mediated fanout (docs/specs/graph-mediated-fanout-
// phase2 §3). Given a running child's runId, return that run's fanout siblings
// as the compact Phase 1 shape — capability + status + ≤280-char summary +
// attempts — and NEVER their full payloads. A running child calls this to check
// "has a sibling already covered X?" before burning tokens; a sibling's full
// output is one agent.subagent.result.get away, same steering rule as aggregate.
// One indexed query over the fanout's runs; no graph round-trip on the hot path.
export const agentSubagentSiblings = registerCapability({
  name: "list_subagent_siblings",
  domain: "agent",
  description:
    "Given a running fanout child's runId, return its sibling runs as compact rows " +
    "(capability, status, summary, attempts) so the caller can see what siblings already " +
    "covered before burning tokens — NEVER full payloads; a sibling's full output is one " +
    "agent.subagent.result.get away.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    runId: z
      .string()
      .describe(
        "Public ID of the calling child run (sar_…) whose siblings to list",
      ),
  }),
  output: z.object({
    runId: z.string().describe("The calling run's public ID, echoed back"),
    fanoutId: z
      .string()
      .describe("Public ID of the fanout these runs belong to"),
    siblings: z
      .array(
        z.object({
          runId: z.string(),
          capabilityName: z.string(),
          status: z.enum(["pending", "running", "completed", "failed"]),
          summary: z
            .string()
            .nullable()
            .describe(
              "The child's compact structural digest, when one was recorded",
            ),
          attempts: z
            .number()
            .int()
            .describe("How many times this run has been attempted/leased"),
          errorReason: z.string().nullable(),
        }),
      )
      .describe(
        "Fanout siblings, EXCLUDING the calling run itself — compact rows, never payloads",
      ),
  }),
});

export type AgentSubagentSiblingsInput = z.output<
  typeof agentSubagentSiblings.input
>;
export type AgentSubagentSiblingsOutput = z.output<
  typeof agentSubagentSiblings.output
>;
