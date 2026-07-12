import { z } from "zod";
import { registerCapability } from "../registry";

// agent.debug.trace (debug_with_trace) — deterministic-first structured failure
// diagnosis for one agent execution. ADR-021 §3: instead of dumping 10k lines of
// logs into the model's context, this returns a small, typed FAILURE FRAME —
// the failing step, the error class + message, the parsed top stack frames, the
// related trace spans, and the suspect files ranked DETERMINISTICALLY (by stack
// frames + tool-call args, no model call). An optional LLM `diagnosis` is
// produced ONLY when `summarize: true` (ADR-021 §1 ladder — deterministic
// extraction is the default; the model is the last rung).
//
// Composes three deterministic sources: the Postgres span tree (agent.trace.get),
// the ClickHouse error_events captured for the execution (keyed by execution_id
// since migration 0022), and the ClickHouse execution_logs — all bounded before
// they reach the frame so the output is safe to feed to a model.

const stackFrame = z.object({
  functionName: z.string().nullable(),
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  internal: z.boolean().describe("node-internal frame (node:…) — de-prioritised as a suspect"),
  raw: z.string(),
});

const relatedSpan = z.object({
  kind: z.enum(["execution", "step", "toolCall"]),
  id: z.string().describe("Public id (aex_/aes_/atc_…), never a bare UUID"),
  label: z.string().describe("Human label: step type, tool name, or origin"),
  status: z.string(),
  failureReason: z.string().nullable(),
  latencyMs: z.number().int().nullable(),
});

const suspectFile = z.object({
  path: z.string(),
  score: z.number().describe("Deterministic weighted score; higher = more likely the fix site"),
  reasons: z.array(z.string()).describe("Why it scored, e.g. 'stack-frame ×3', 'tool-arg'"),
});

const failingStep = z
  .object({
    stepId: z.string().nullable(),
    stepNumber: z.number().int().nullable(),
    stepType: z.string().nullable(),
    toolName: z.string().nullable().describe("Set when the failure surfaced inside a tool call"),
    toolCallId: z.string().nullable(),
    status: z.string(),
    failureReason: z.string().nullable(),
    latencyMs: z.number().int().nullable(),
  })
  .nullable();

const errorEventSummary = z.object({
  severity: z.enum(["fatal", "error", "warn"]),
  source: z.string(),
  errorClass: z.string(),
  message: z.string(),
  fingerprint: z.string(),
  stepId: z.string().nullable(),
  createdAt: z.string(),
});

const logLine = z.object({
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  stepId: z.string().nullable(),
  createdAt: z.string(),
});

// Optional LLM-produced root-cause diagnosis. Mirrors the Diagnosis artifact in
// @oxagen/agent-engine (evaluate/diagnosis.ts); produced only on summarize:true.
const diagnosis = z
  .object({
    problem: z.string(),
    expectedBehavior: z.string(),
    rootCauseHypotheses: z.array(
      z.object({
        id: z.string(),
        statement: z.string(),
        evidence: z.string(),
        probeResult: z.enum(["survived", "falsified"]).optional(),
      }),
    ),
    blastRadius: z.array(z.string()),
    diffBudget: z.number().int(),
  })
  .nullable();

const failureFrame = z.object({
  executionId: z.string().describe("Resolved public id (aex_…) of the inspected execution"),
  status: z.string().describe("Root execution status"),
  failingStep,
  errorClass: z.string().nullable().describe("From the captured error_events, else parsed from the failure reason"),
  message: z.string().nullable().describe("Bounded error message"),
  topFrames: z.array(stackFrame).describe("Parsed top stack frames (deterministic, capped)"),
  relatedSpans: z.array(relatedSpan).describe("Flattened span subtree, failed-first, bounded"),
  suspectFiles: z.array(suspectFile).describe("Files ranked deterministically as likely fix sites"),
  errorEvents: z.array(errorEventSummary).describe("Bounded sample of errors captured for this execution"),
  logsSample: z.array(logLine).describe("Bounded tail of warn/error/fatal execution logs"),
  diagnosis: diagnosis.describe("LLM root-cause diagnosis — only when summarize:true, else null"),
  truncated: z
    .object({
      spans: z.boolean(),
      frames: z.boolean(),
      suspectFiles: z.boolean(),
      errorEvents: z.boolean(),
      logs: z.boolean(),
    })
    .describe("Which lists the deterministic compressor clipped to their caps"),
});

export const agentDebugTrace = registerCapability({
  name: "debug_execution",
  domain: "agent",
  description:
    "Diagnose why an agent execution failed as a structured frame: the failing step, error class + message, parsed top stack frames, related spans, and suspect files ranked deterministically. Prefer this over reading raw logs or the full trace when an execution has failed and you need the fix site. Not for successful runs (use agent.trace.get) or for listing runs (use agent.execution.list). Set summarize:true to also get an LLM root-cause diagnosis.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "introspection" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    executionId: z
      .string()
      .describe("Public ID (aex_…) or UUID of the failed execution to diagnose"),
    depth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Max child-execution depth to include in related spans (default: full bounded tree)"),
    summarize: z
      .boolean()
      .optional()
      .describe("When true, also run ONE model call to produce a root-cause diagnosis (default false: deterministic only)"),
  }),
  output: failureFrame,
});

export type AgentDebugTraceInput = z.output<typeof agentDebugTrace.input>;
export type AgentDebugTraceOutput = z.output<typeof agentDebugTrace.output>;
