import { z } from "zod";
import { registerCapability } from "../registry";

// Detail view for one subagent fan-out: the aggregate row plus every child
// run with its capability, live status, timings, error reason, and a bounded
// preview of the input/output payloads. Polled by the in-app viewer for live
// status, and callable from the agent/MCP/API surfaces.
export const agentSubagentFanoutGet = registerCapability({
  name: "get_subagent_fanout",
  domain: "agent",
  description:
    "Get one subagent fan-out with its child runs — each child's capability, status, timings, error reason, and input/output size + preview.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
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
    fanoutId: z.string().describe("Public ID of the fan-out to fetch"),
  }),
  output: z.object({
    fanoutId: z.string(),
    parentMessageId: z.string(),
    status: z.enum(["pending", "running", "completed", "partial", "timed_out"]),
    totalChildren: z.number().int(),
    completedChildren: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    runs: z.array(
      z.object({
        runId: z.string(),
        capabilityName: z.string(),
        status: z.enum(["pending", "running", "completed", "failed"]),
        errorReason: z.string().nullable(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        durationMs: z
          .number()
          .int()
          .nullable()
          .describe("Wall-clock duration once the run has completed"),
        inputBytes: z
          .number()
          .int()
          .describe("Serialized size of the input payload"),
        outputBytes: z
          .number()
          .int()
          .describe("Serialized size of the output payload, 0 when none"),
        outputPreview: z
          .string()
          .nullable()
          .describe(
            "Truncated JSON preview of the output payload, or null when none",
          ),
      }),
    ),
  }),
});

export type AgentSubagentFanoutGetInput = z.output<
  typeof agentSubagentFanoutGet.input
>;
export type AgentSubagentFanoutGetOutput = z.output<
  typeof agentSubagentFanoutGet.output
>;
