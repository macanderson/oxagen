import { withTenantDb, schema } from "@oxagen/database";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  createSession,
  appendEvent,
  analyzeReplay,
  extractTurnMetrics,
} from "@oxagen/engram";
import type { CapabilityContext } from "../types";
import type {
  AgentTraceGetInput,
  AgentTraceGetOutput,
  TraceExecutionNode,
} from "@oxagen/oxagen/contracts/agent.trace.get";
import { ExecutionNotFoundError } from "./subagent-errors";

export type { AgentTraceGetInput, AgentTraceGetOutput };

// Bounds on the traversal so a pathological lineage chain can never fan the read
// into an unbounded query storm or an unbounded client payload.
const MAX_NODES = 200;
const MAX_DEPTH = 10;
const PREVIEW_MAX_CHARS = 500;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function byteSize(v: unknown): number {
  if (v === null || v === undefined) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(v)).length;
  } catch {
    return 0;
  }
}

function preview(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(v);
  } catch {
    return null;
  }
  return serialized.length > PREVIEW_MAX_CHARS
    ? `${serialized.slice(0, PREVIEW_MAX_CHARS)}…`
    : serialized;
}

// Drizzle-selected shape for one execution row (the columns we project).
interface ExecRow {
  id: string;
  publicId: string;
  agentId: string | null;
  originType: string;
  originId: string;
  status: string;
  failureReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: string | null;
  parentExecutionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const execColumns = {
  id: schema.agentExecutions.id,
  publicId: schema.agentExecutions.publicId,
  agentId: schema.agentExecutions.agentId,
  originType: schema.agentExecutions.originType,
  originId: schema.agentExecutions.originId,
  status: schema.agentExecutions.status,
  failureReason: schema.agentExecutions.failureReason,
  startedAt: schema.agentExecutions.startedAt,
  completedAt: schema.agentExecutions.completedAt,
  latencyMs: schema.agentExecutions.latencyMs,
  inputTokens: schema.agentExecutions.inputTokens,
  outputTokens: schema.agentExecutions.outputTokens,
  estimatedCostUsd: schema.agentExecutions.estimatedCostUsd,
  parentExecutionId: schema.agentExecutions.parentExecutionId,
  createdAt: schema.agentExecutions.createdAt,
  updatedAt: schema.agentExecutions.updatedAt,
} as const;

/**
 * Load one agent execution as a span tree. Reads Postgres — the authoritative
 * parent/child source (Neo4j does not carry the execution→execution edge).
 *
 * Strategy: resolve the root, then breadth-first collect descendant executions
 * via parent_execution_id (capped by MAX_NODES/MAX_DEPTH), then batch-load all
 * steps and tool calls for the collected executions in two queries and assemble
 * the tree in memory. Every query is tenant-scoped.
 */
export async function agentTraceGetHandler(
  input: AgentTraceGetInput,
  ctx: CapabilityContext,
): Promise<AgentTraceGetOutput> {
  const byUuid = UUID_RE.test(input.executionId);

  const { execs, order } = await withTenantDb(async (tx) => {
    // ── Root ──
    const [root] = (await tx
      .select(execColumns)
      .from(schema.agentExecutions)
      .where(
        and(
          byUuid
            ? eq(schema.agentExecutions.id, input.executionId)
            : eq(schema.agentExecutions.publicId, input.executionId),
          eq(schema.agentExecutions.orgId, ctx.orgId),
          eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1)) as ExecRow[];

    if (!root) return { execs: null, order: [] as string[] };

    // ── Descendants: BFS over parent_execution_id, bounded ──
    const collected = new Map<string, ExecRow>([[root.id, root]]);
    const order: string[] = [root.id];
    let frontier = [root.id];
    let depth = 0;
    while (
      frontier.length > 0 &&
      depth < MAX_DEPTH &&
      collected.size < MAX_NODES
    ) {
      const children = (await tx
        .select(execColumns)
        .from(schema.agentExecutions)
        .where(
          and(
            inArray(schema.agentExecutions.parentExecutionId, frontier),
            eq(schema.agentExecutions.orgId, ctx.orgId),
            eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
          ),
        )
        .orderBy(asc(schema.agentExecutions.createdAt))) as ExecRow[];

      const next: string[] = [];
      for (const child of children) {
        if (collected.has(child.id)) continue; // guard against cycles
        if (collected.size >= MAX_NODES) break;
        collected.set(child.id, child);
        order.push(child.id);
        next.push(child.id);
      }
      frontier = next;
      depth += 1;
    }

    return { execs: collected, order };
  });

  if (!execs) throw new ExecutionNotFoundError(input.executionId);

  const execIds = order;

  // ── Batch-load steps for every collected execution ──
  const steps = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.agentExecutionSteps.id,
        publicId: schema.agentExecutionSteps.publicId,
        executionId: schema.agentExecutionSteps.executionId,
        stepNumber: schema.agentExecutionSteps.stepNumber,
        stepType: schema.agentExecutionSteps.stepType,
        status: schema.agentExecutionSteps.status,
        failureReason: schema.agentExecutionSteps.failureReason,
        startedAt: schema.agentExecutionSteps.startedAt,
        completedAt: schema.agentExecutionSteps.completedAt,
        latencyMs: schema.agentExecutionSteps.latencyMs,
        inputTokens: schema.agentExecutionSteps.inputTokens,
        outputTokens: schema.agentExecutionSteps.outputTokens,
      })
      .from(schema.agentExecutionSteps)
      .where(
        and(
          inArray(schema.agentExecutionSteps.executionId, execIds),
          eq(schema.agentExecutionSteps.orgId, ctx.orgId),
          eq(schema.agentExecutionSteps.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(asc(schema.agentExecutionSteps.stepNumber)),
  );

  const stepIds = steps.map((s) => s.id);

  // ── Batch-load tool calls for every collected step ──
  const toolCalls =
    stepIds.length === 0
      ? []
      : await withTenantDb((tx) =>
          tx
            .select({
              id: schema.agentToolCalls.id,
              publicId: schema.agentToolCalls.publicId,
              executionStepId: schema.agentToolCalls.executionStepId,
              toolName: schema.agentToolCalls.toolName,
              toolType: schema.agentToolCalls.toolType,
              status: schema.agentToolCalls.status,
              latencyMs: schema.agentToolCalls.latencyMs,
              inputTokens: schema.agentToolCalls.inputTokens,
              outputTokens: schema.agentToolCalls.outputTokens,
              requestPayload: schema.agentToolCalls.requestPayload,
              responsePayload: schema.agentToolCalls.responsePayload,
            })
            .from(schema.agentToolCalls)
            .where(
              and(
                inArray(schema.agentToolCalls.executionStepId, stepIds),
                eq(schema.agentToolCalls.orgId, ctx.orgId),
                eq(schema.agentToolCalls.workspaceId, ctx.workspaceId),
              ),
            )
            .orderBy(asc(schema.agentToolCalls.createdAt)),
        );

  // ── Index tool calls by step, steps by execution ──
  const toolCallsByStep = new Map<
    string,
    AgentTraceGetOutput["steps"][number]["toolCalls"]
  >();
  for (const tc of toolCalls) {
    const list = toolCallsByStep.get(tc.executionStepId) ?? [];
    list.push({
      toolCallId: tc.publicId,
      toolName: tc.toolName,
      toolType: tc.toolType,
      status:
        tc.status as AgentTraceGetOutput["steps"][number]["toolCalls"][number]["status"],
      latencyMs: tc.latencyMs,
      inputTokens: tc.inputTokens,
      outputTokens: tc.outputTokens,
      requestBytes: byteSize(tc.requestPayload),
      responseBytes: byteSize(tc.responsePayload),
      responsePreview: preview(tc.responsePayload),
    });
    toolCallsByStep.set(tc.executionStepId, list);
  }

  const stepsByExec = new Map<string, AgentTraceGetOutput["steps"]>();
  for (const s of steps) {
    const list = stepsByExec.get(s.executionId) ?? [];
    list.push({
      stepId: s.publicId,
      stepNumber: s.stepNumber,
      stepType: s.stepType,
      status: s.status as AgentTraceGetOutput["steps"][number]["status"],
      failureReason: s.failureReason,
      startedAt: s.startedAt ? s.startedAt.toISOString() : null,
      completedAt: s.completedAt ? s.completedAt.toISOString() : null,
      latencyMs: s.latencyMs,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      toolCalls: toolCallsByStep.get(s.id) ?? [],
    });
    stepsByExec.set(s.executionId, list);
  }

  // ── Assemble the recursive tree ──
  const childrenByParent = new Map<string, string[]>();
  const rootId = execIds[0]!;
  for (const id of execIds) {
    const row = execs.get(id)!;
    const parent = row.parentExecutionId;
    // Only nest under a parent we actually collected (root's own parent, if any,
    // is outside this trace and treated as absent so the root stays the root).
    if (parent && parent !== id && execs.has(parent)) {
      const list = childrenByParent.get(parent) ?? [];
      list.push(id);
      childrenByParent.set(parent, list);
    }
  }

  function build(id: string): TraceExecutionNode {
    const row = execs!.get(id)!;
    return {
      executionId: row.publicId,
      status: row.status as TraceExecutionNode["status"],
      originType: row.originType,
      originId: row.originId,
      agentId: row.agentId,
      failureReason: row.failureReason,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      latencyMs: row.latencyMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      estimatedCostUsd: row.estimatedCostUsd,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      steps: stepsByExec.get(id) ?? [],
      children: (childrenByParent.get(id) ?? []).map(build),
    };
  }

  const root = build(rootId);
  const { turnMetrics, replayDeterministic } = deriveTurnMetrics(root, ctx);
  return { ...root, turnMetrics, replayDeterministic };
}

/**
 * Treat each of the root execution's steps as one "turn" of a synthetic
 * @oxagen/engram Session, then reuse session/replay.ts's extractTurnMetrics
 * (per-step compile time / tokens / tool-call count / outcome) and
 * analyzeReplay (a determinism sanity-check over the synthesized metrics) to
 * power the trace UI's per-step metrics panel. Postgres execution rows don't
 * carry engram's context-compile cache telemetry (candidatesRetrieved/
 * cacheHitRate), so those fields are always 0/omitted here — this reuses the
 * turn/tool-call/outcome shape, not the context-compile-specific one.
 */
function deriveTurnMetrics(
  root: TraceExecutionNode,
  ctx: CapabilityContext,
): {
  turnMetrics: NonNullable<TraceExecutionNode["turnMetrics"]>;
  replayDeterministic: boolean;
} {
  const session = createSession(root.executionId, {
    org: ctx.orgId,
    workspace: ctx.workspaceId,
  });
  for (const step of root.steps) {
    const totalTokens = (step.inputTokens ?? 0) + (step.outputTokens ?? 0);
    appendEvent(session, "turn_start", step.stepId, {});
    appendEvent(session, "context_compiled", step.stepId, {
      candidatesRetrieved: 0,
      candidatesPacked: 0,
      candidatesEvicted: 0,
      totalTokens,
      cacheHitRate: 0,
      compileMs: step.latencyMs ?? 0,
    });
    for (const tc of step.toolCalls) {
      appendEvent(session, "tool_call", step.stepId, {
        tool: tc.toolName,
        input: null,
      });
    }
    appendEvent(session, "turn_end", step.stepId, {
      outcome:
        step.status === "completed"
          ? "success"
          : step.status === "failed"
            ? "failure"
            : "interrupted",
      totalTokens,
      durationMs: step.latencyMs ?? 0,
    });
  }
  const turnMetrics = extractTurnMetrics(session).map((m) => ({
    turnId: m.turnId,
    compileMs: m.compileMs,
    tokens: m.tokens,
    cacheHitRate: m.cacheHitRate,
    toolCalls: m.toolCalls,
    outcome: m.outcome,
  }));
  const replay = analyzeReplay(session);
  return { turnMetrics, replayDeterministic: replay.deterministic };
}
