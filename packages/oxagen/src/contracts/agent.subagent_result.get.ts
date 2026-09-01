import { z } from "zod";
import { registerCapability } from "../registry";

// Scoped on-demand read of ONE subagent child run's full result. This is the
// counterpart to the compact-by-default agent.subagent.aggregate: aggregate
// returns ≤280-char summaries + runId refs, and a caller fetches the single
// child whose full payload it actually needs here — instead of every child's
// output being relayed into the parent LLM context on every aggregate call
// (docs/specs/graph-mediated-fanout).
export const agentSubagentResultGet = registerCapability({
  name: "get_subagent_result",
  domain: "agent",
  description:
    "Fetch ONE subagent child run's full input + output payloads by runId (from agent.subagent.aggregate " +
    "children[] or timeline[]). Use only when a child's summary is insufficient — do not fetch every child; " +
    "summaries plus conflicts are usually enough.",
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
        "Public ID of the child run to fetch (sar_… from aggregate children[].runId)",
      ),
  }),
  output: z.object({
    runId: z.string(),
    fanoutId: z
      .string()
      .describe("Public ID of the fanout this run belongs to"),
    capabilityName: z.string(),
    status: z.enum(["pending", "running", "completed", "failed"]),
    summary: z
      .string()
      .nullable()
      .describe(
        "The structural digest aggregate returned, when one was recorded",
      ),
    input: z
      .unknown()
      .describe("Full input payload the child was dispatched with"),
    output: z
      .unknown()
      .describe("Full output payload, null until the run completes"),
    errorReason: z.string().nullable(),
    startedAt: z.string().nullable(),
    completedAt: z.string().nullable(),
  }),
});

export type AgentSubagentResultGetInput = z.output<
  typeof agentSubagentResultGet.input
>;
export type AgentSubagentResultGetOutput = z.output<
  typeof agentSubagentResultGet.output
>;
