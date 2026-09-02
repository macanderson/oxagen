/**
 * `oxagen trace <executionId>` — print one agent execution as a span tree.
 *
 * Fetches agent.trace.get over the API (GET /v1/<org>/<ws>/agent/trace/:id) and
 * renders the run, its ordered steps, each step's tool calls (with durations and
 * token figures), and any child executions (subagent / A2A lineage) as an
 * indented tree. `--json` prints the raw contract output for scripting.
 */
import { apiGetOrThrow, ApiError } from "../lib/api.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";

export interface TraceOptions {
  json?: boolean;
}

// Local mirror of the agent.trace.get contract output. The CLI talks to the API
// over HTTP and does not depend on @oxagen/oxagen, so the response shape is
// declared here (kept in sync with packages/oxagen/src/contracts/agent.trace.get.ts).
interface ToolCallNode {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  requestBytes: number;
  responseBytes: number;
  responsePreview: string | null;
}
interface StepNode {
  stepId: string;
  stepNumber: number;
  stepType: string;
  status: string;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolCalls: ToolCallNode[];
}
interface ExecNode {
  executionId: string;
  status: string;
  originType: string;
  originId: string;
  agentId: string | null;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  createdAt: string;
  updatedAt: string;
  steps: StepNode[];
  children: ExecNode[];
}
type AgentTraceGetOutput = ExecNode;

function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok === null && outTok === null) return "";
  return ` [${inTok ?? 0}→${outTok ?? 0} tok]`;
}

function statusMark(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
    case "cancelled":
      return "✗";
    case "running":
      return "◷";
    default:
      return "•";
  }
}

function renderToolCall(tc: ToolCallNode, indent: string, out: string[]): void {
  out.push(
    `${indent}${statusMark(tc.status)} tool ${tc.toolName} (${tc.toolType}) ` +
      `${fmtDuration(tc.latencyMs)}${fmtTokens(tc.inputTokens, tc.outputTokens)}`,
  );
}

function renderStep(step: StepNode, indent: string, out: string[]): void {
  out.push(
    `${indent}${statusMark(step.status)} step ${step.stepNumber} ${step.stepType} ` +
      `${fmtDuration(step.latencyMs)}${fmtTokens(step.inputTokens, step.outputTokens)}` +
      (step.failureReason ? ` — ${step.failureReason}` : ""),
  );
  for (const tc of step.toolCalls) renderToolCall(tc, `${indent}    `, out);
}

/**
 * Render one execution and its children. `seen` carries the executionIds
 * already rendered on the current path: the child list is server-supplied, so a
 * malformed trace (an execution reachable from itself) must terminate with a
 * marker rather than recurse until the stack overflows.
 */
function renderExecution(
  node: ExecNode,
  indent: string,
  out: string[],
  seen: ReadonlySet<string> = new Set(),
): void {
  if (seen.has(node.executionId)) {
    out.push(`${indent}↺ execution ${node.executionId} — cycle, not expanded`);
    return;
  }
  const cost = node.estimatedCostUsd ? ` $${node.estimatedCostUsd}` : "";
  out.push(
    `${indent}${statusMark(node.status)} execution ${node.executionId} ` +
      `[${node.originType}] ${node.status} ${fmtDuration(node.latencyMs)}` +
      `${fmtTokens(node.inputTokens, node.outputTokens)}${cost}` +
      (node.failureReason ? ` — ${node.failureReason}` : ""),
  );
  const path = new Set(seen).add(node.executionId);
  for (const step of node.steps) renderStep(step, `${indent}  `, out);
  for (const child of node.children)
    renderExecution(child, `${indent}  `, out, path);
}

export async function handleTrace(
  executionId: string,
  opts: TraceOptions,
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  let trace: AgentTraceGetOutput;
  try {
    trace = await apiGetOrThrow<AgentTraceGetOutput>(
      `agent/trace/${encodeURIComponent(executionId)}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      writer.writeErr(`Execution not found: ${executionId}`);
    } else {
      writer.writeErr(err instanceof Error ? err.message : String(err));
    }
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    writer.write(JSON.stringify(trace, null, 2));
    return;
  }

  const out: string[] = [];
  renderExecution(trace, "", out);
  writer.write(out.join("\n"));
}
