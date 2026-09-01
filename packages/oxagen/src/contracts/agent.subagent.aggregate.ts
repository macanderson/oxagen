import { z } from "zod";
import { registerCapability } from "../registry";

// Serialized-size caps for the legacy full-payload mode and the opt-in merge.
// Exported so the handler and its tests share one source of truth.
// (docs/specs/graph-mediated-fanout — payloads must never grow unbounded in an
// LLM-facing tool result again.)
export const AGGREGATE_CHILD_OUTPUT_CAP_BYTES = 8 * 1024;
export const AGGREGATE_MERGED_CAP_BYTES = 16 * 1024;

export const agentSubagentAggregate = registerCapability({
  name: "aggregate_subagents",
  domain: "agent",
  description:
    "Return the status, per-child summaries, conflict list, and execution timeline for a subagent fanout. " +
    "Compact by default: each child carries a ≤280-char summary plus its runId — fetch ONE child's full " +
    "output with agent.subagent.result.get only when its summary is insufficient; do not fetch every child. " +
    "While the fanout is still running the response is counts + recheckAfterMs only — wait that long before " +
    "checking again instead of polling in a tight loop. Non-blocking: durable waiting is handled by the " +
    "agent.aggregate-fanout Inngest function.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "background" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    fanoutId: z
      .string()
      .describe("Public ID of the subagent fanout to aggregate"),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 60 * 1000)
      .default(5 * 60 * 1000)
      .describe(
        "Snapshot window in ms: a still-running fanout older than this is reported as 'timed_out' rather than 'running' (default 5 min, max 30 min). Non-blocking — the handler never sleeps.",
      ),
    includeOutputs: z
      .boolean()
      .default(false)
      .describe(
        "DEPRECATED legacy mode: include each child's full input + output payloads in children[] " +
          `(outputs capped at ${AGGREGATE_CHILD_OUTPUT_CAP_BYTES} serialized bytes each, marked outputTruncated when clipped). ` +
          "Default false — children carry summaries + runId refs; fetch one child's full output with agent.subagent.result.get.",
      ),
    includeMerged: z
      .boolean()
      .default(false)
      .describe(
        "Include aggregatedData — the deep-merged outputs of all successful children " +
          `(capped at ${AGGREGATE_MERGED_CAP_BYTES} serialized bytes; null + aggregatedDataTruncated when over). ` +
          "Default false. conflicts[] is always computed and returned regardless.",
      ),
  }),
  output: z.object({
    fanoutId: z.string(),
    status: z
      .enum([
        "pending",
        "running",
        "completed",
        "partial",
        "failed",
        "timed_out",
      ])
      .describe(
        "running/pending = children still executing (aggregatedData null); completed = all succeeded; partial = some succeeded, some failed/incomplete (merged data of the successful subset); failed = none succeeded; timed_out = still unfinished past the snapshot window",
      ),
    totalChildren: z.number().int(),
    completedChildren: z.number().int(),
    aggregatedData: z
      .record(z.unknown())
      .nullable()
      .describe(
        "Merged output data from all successful runs. Null unless includeMerged is true (and null while running / when over the size cap).",
      ),
    aggregatedDataTruncated: z
      .boolean()
      .describe(
        `True when includeMerged was requested but the merge exceeded ${AGGREGATE_MERGED_CAP_BYTES} serialized bytes — fetch per-child outputs via agent.subagent.result.get instead.`,
      ),
    conflicts: z
      .array(
        z.object({
          key: z.string(),
          values: z.array(z.unknown()),
          runIds: z.array(z.string()),
        }),
      )
      .describe("Keys where two or more runs produced different values"),
    timeline: z.array(
      z.object({
        runId: z.string(),
        capabilityName: z.string(),
        status: z.string(),
        startedAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        errorReason: z.string().nullable(),
      }),
    ),
    children: z
      .array(
        z.object({
          runId: z.string().describe("Ref for agent.subagent.result.get"),
          capabilityName: z.string(),
          status: z.string(),
          summary: z
            .string()
            .describe(
              "≤280-char structural digest of the child's output (or error)",
            ),
          outputBytes: z
            .number()
            .int()
            .describe(
              "Serialized size of the full output payload, 0 when none",
            ),
          errorReason: z.string().nullable(),
          input: z
            .unknown()
            .optional()
            .describe(
              "Full input payload — present only when includeOutputs is true (deprecated)",
            ),
          output: z
            .unknown()
            .optional()
            .describe(
              "Full output payload — present only when includeOutputs is true (deprecated); capped, see outputTruncated",
            ),
          outputTruncated: z
            .boolean()
            .optional()
            .describe(
              "True when the includeOutputs payload was clipped at the size cap",
            ),
        }),
      )
      .describe(
        "Per-child compact results: runId + summary + size, NOT full payloads. Empty while the fanout " +
          "is still running (compact mode) — use timeline for live per-child status. Fetch a specific " +
          "child's full output via agent.subagent.result.get. With includeOutputs (deprecated) each " +
          "entry also carries its full input/output, preserving each child's distinct result unlike " +
          "aggregatedData's deep-merge.",
      ),
    recheckAfterMs: z
      .number()
      .int()
      .nullable()
      .describe(
        "Suggested wait before the next aggregate call, derived from observed child latency. Non-null only while the fanout is still running; respect it instead of tight-polling.",
      ),
    firstError: z
      .string()
      .nullable()
      .describe("Error reason from the first failed child run, or null"),
  }),
});

export type AgentSubagentAggregateInput = z.output<
  typeof agentSubagentAggregate.input
>;
export type AgentSubagentAggregateOutput = z.output<
  typeof agentSubagentAggregate.output
>;
