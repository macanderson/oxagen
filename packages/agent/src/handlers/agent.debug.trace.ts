import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import {
  fetchErrorEventsForExecution,
  fetchLogsForExecution,
  type ExecutionErrorEvent,
} from "@oxagen/telemetry";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import { z } from "zod";
import type { CapabilityContext } from "../types";
import type {
  AgentDebugTraceInput,
  AgentDebugTraceOutput,
} from "@oxagen/oxagen/contracts/agent.debug.trace";
import { ExecutionNotFoundError } from "./subagent-errors";
import { agentTraceGetHandler } from "./agent.trace.get";
import {
  parseStackFrames,
  flattenSpans,
  findFailingStep,
  suspectFilesFrom,
  extractFilePaths,
  clampMessage,
  clampLogMessage,
  MAX_RELATED_SPANS,
  MAX_TOP_FRAMES,
  MAX_SUSPECT_FILES,
  MAX_LOG_LINES,
  MAX_ERROR_EVENTS,
  type StackFrame,
} from "./debug-frame";

export type { AgentDebugTraceInput, AgentDebugTraceOutput };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// How many tool-call payloads we scan for file-path arguments. Bounded so a
// pathological run can't turn suspect-file mining into an unbounded scan.
const MAX_TOOLCALL_SCAN = 200;

// Levels worth surfacing in a failure post-mortem. Info/debug are excluded so
// the model reads signal, not a chatty transcript (ADR-021 §3).
const FAILURE_LOG_LEVELS = ["warn", "error", "fatal"] as const;

/** Diagnosis schema for the optional model call — mirrors @oxagen/agent-engine's Diagnosis. */
const diagnosisSchema = z.object({
  problem: z.string(),
  expectedBehavior: z.string(),
  rootCauseHypotheses: z
    .array(
      z.object({
        id: z.string(),
        statement: z.string(),
        evidence: z.string(),
      }),
    )
    .min(1)
    .max(3),
  blastRadius: z.array(z.string()),
  diffBudget: z.number().int().positive(),
});

const DIAGNOSIS_SYSTEM =
  "You are a senior debugging engineer. Given a STRUCTURED failure frame (already " +
  "extracted deterministically — failing step, error class, top stack frames, " +
  "related spans, ranked suspect files, sampled errors/logs), produce a concise " +
  "root-cause diagnosis. Base every claim on the frame; do not invent files or " +
  "stack frames that aren't present. 1–3 distinct root-cause hypotheses, most " +
  "likely first. blastRadius = the suspect files a fix would touch. diffBudget = " +
  "estimated lines changed.";

/**
 * agent.debug.trace (debug_with_trace) — deterministic-first structured failure
 * diagnosis. Composes three bounded, deterministic sources into one small frame
 * (ADR-021 §3 — raw output never reaches the model):
 *   1. the Postgres span tree (reuses agent.trace.get) → related spans + failing step,
 *   2. ClickHouse error_events for the execution → error class, message, stack frames,
 *   3. ClickHouse execution_logs (warn/error/fatal) → a bounded log tail,
 *   4. the failing execution's tool-call arguments → suspect-file signal.
 * Suspect files are ranked by a pure function (no model). The optional model call
 * (diagnosis) runs ONLY when input.summarize === true.
 */
export async function agentDebugTraceHandler(
  input: AgentDebugTraceInput,
  ctx: CapabilityContext,
): Promise<AgentDebugTraceOutput> {
  const byUuid = UUID_RE.test(input.executionId);

  // ── Resolve the root execution to its internal UUID (the key error_events /
  //    execution_logs are stamped with) + public id + status. Tenant-scoped. ──
  const root = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.agentExecutions.id,
        publicId: schema.agentExecutions.publicId,
        status: schema.agentExecutions.status,
      })
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
      .limit(1);
    return row ?? null;
  });

  if (!root) throw new ExecutionNotFoundError(input.executionId);

  // ── Span tree (canonical shape, reused) → related spans + failing step. ──
  const tree = await agentTraceGetHandler({ executionId: root.publicId }, ctx);
  const relatedSpansAll = flattenSpans(tree, Number.MAX_SAFE_INTEGER);
  const relatedSpans = relatedSpansAll.slice(0, MAX_RELATED_SPANS);
  const failingStep = findFailingStep(tree);

  // ── Captured errors + logs for this execution (bounded CH reads). ──
  const [errorEvents, logs, toolArgPaths] = await Promise.all([
    fetchErrorEventsForExecution({
      orgId: ctx.orgId,
      executionId: root.id,
      limit: MAX_ERROR_EVENTS,
    }),
    fetchLogsForExecution({
      orgId: ctx.orgId,
      executionId: root.id,
      levels: FAILURE_LOG_LEVELS,
      limit: MAX_LOG_LINES,
    }),
    fetchToolArgFilePaths(ctx, root.id),
  ]);

  // ── Deterministic extraction (ADR-021 §3 compressor). ──
  // Primary error signal: the most severe / most recent captured error.
  const primaryError = pickPrimaryError(errorEvents);
  const allFramesFromErrors: StackFrame[] = errorEvents.flatMap((e) =>
    parseStackFrames(e.stack, MAX_TOP_FRAMES),
  );
  // Top frames come from the primary error's stack; fall back to any error's.
  const topFrames = (
    primaryError
      ? parseStackFrames(primaryError.stack, MAX_TOP_FRAMES)
      : allFramesFromErrors
  ).slice(0, MAX_TOP_FRAMES);

  const failureText: string[] = [
    failingStep?.failureReason ?? "",
    tree.failureReason ?? "",
    ...errorEvents.map((e) => e.message),
    ...relatedSpans.map((s) => s.failureReason ?? ""),
    ...logs.map((l) => l.message),
  ].filter((t) => t !== "");

  const suspectFiles = suspectFilesFrom({
    stackFrames: allFramesFromErrors,
    toolArgPaths,
    failureText,
  });

  const errorClass =
    primaryError?.errorClass ??
    classFromFailureReason(failingStep?.failureReason ?? tree.failureReason);
  const message = clampMessage(
    primaryError?.message ?? failingStep?.failureReason ?? tree.failureReason,
  );

  const frame: AgentDebugTraceOutput = {
    executionId: root.publicId,
    status: root.status,
    failingStep,
    errorClass,
    message,
    topFrames,
    relatedSpans,
    suspectFiles,
    errorEvents: errorEvents.slice(0, MAX_ERROR_EVENTS).map((e) => ({
      severity: e.severity,
      source: e.source,
      errorClass: e.errorClass,
      message: clampMessage(e.message) ?? "",
      fingerprint: e.fingerprint,
      stepId: e.stepId,
      createdAt: e.createdAt,
    })),
    logsSample: logs.slice(0, MAX_LOG_LINES).map((l) => ({
      level: l.logLevel,
      message: clampLogMessage(l.message),
      stepId: l.stepId,
      createdAt: l.createdAt,
    })),
    diagnosis: null,
    truncated: {
      spans: relatedSpansAll.length > MAX_RELATED_SPANS,
      frames: allFramesFromErrors.length > topFrames.length,
      suspectFiles: suspectFiles.length >= MAX_SUSPECT_FILES,
      errorEvents: errorEvents.length >= MAX_ERROR_EVENTS,
      logs: logs.length >= MAX_LOG_LINES,
    },
  };

  // ── Optional model rung (ADR-021 §1): a natural-language root-cause narrative
  //    is open-ended synthesis over heterogeneous evidence — no function/index/
  //    cache can produce it — so it is the ONLY part gated behind a model, and
  //    only when the caller explicitly asks (summarize:true). Failure of the
  //    model leaves the deterministic frame intact (heuristic fallback = null). ──
  if (input.summarize) {
    frame.diagnosis = await summarizeDiagnosis(frame, ctx);
  }

  return frame;
}

/** The most actionable captured error: fatal > error > warn, then most recent. */
function pickPrimaryError(
  events: ExecutionErrorEvent[],
): ExecutionErrorEvent | null {
  if (events.length === 0) return null;
  const rank = { fatal: 3, error: 2, warn: 1 } as const;
  return (
    [...events].sort(
      (a, b) =>
        rank[b.severity] - rank[a.severity] ||
        b.createdAt.localeCompare(a.createdAt),
    )[0] ?? null
  );
}

/** Best-effort error class from a failure reason like "TypeError: x" — else null. */
function classFromFailureReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  const m = reason.match(/^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b/);
  return m?.[1] ?? null;
}

/** Pull file-path arguments from the root execution's tool calls (bounded). */
async function fetchToolArgFilePaths(
  ctx: CapabilityContext,
  executionInternalId: string,
): Promise<string[]> {
  const payloads = await withTenantDb(async (tx) => {
    const steps = await tx
      .select({ id: schema.agentExecutionSteps.id })
      .from(schema.agentExecutionSteps)
      .where(
        and(
          eq(schema.agentExecutionSteps.executionId, executionInternalId),
          eq(schema.agentExecutionSteps.orgId, ctx.orgId),
          eq(schema.agentExecutionSteps.workspaceId, ctx.workspaceId),
        ),
      );
    const stepIds = steps.map((s) => s.id);
    if (stepIds.length === 0) return [] as unknown[];
    const calls = await tx
      .select({ requestPayload: schema.agentToolCalls.requestPayload })
      .from(schema.agentToolCalls)
      .where(
        and(
          inArray(schema.agentToolCalls.executionStepId, stepIds),
          eq(schema.agentToolCalls.orgId, ctx.orgId),
          eq(schema.agentToolCalls.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(MAX_TOOLCALL_SCAN);
    return calls.map((c) => c.requestPayload);
  });

  const paths = new Set<string>();
  for (const payload of payloads) {
    if (payload === null || payload === undefined) continue;
    let text: string;
    try {
      text = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      continue;
    }
    for (const p of extractFilePaths(text)) paths.add(p);
  }
  return [...paths];
}

/** One structured model call producing the Diagnosis. Never throws — null on failure. */
async function summarizeDiagnosis(
  frame: AgentDebugTraceOutput,
  ctx: CapabilityContext,
): Promise<AgentDebugTraceOutput["diagnosis"]> {
  // The frame is already bounded/compressed, so this prompt is small and stable.
  const compact = JSON.stringify({
    status: frame.status,
    failingStep: frame.failingStep,
    errorClass: frame.errorClass,
    message: frame.message,
    topFrames: frame.topFrames.map((f) => f.raw),
    suspectFiles: frame.suspectFiles,
    errorEvents: frame.errorEvents.map((e) => ({
      errorClass: e.errorClass,
      message: e.message,
    })),
    logsSample: frame.logsSample.map((l) => `[${l.level}] ${l.message}`),
  });
  try {
    const { object } = await generateObjectFor({
      schema: diagnosisSchema,
      model: selectModel({ tier: "balanced" }),
      system: DIAGNOSIS_SYSTEM,
      messages: [{ role: "user", content: `Failure frame:\n${compact}` }],
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? ctx.requestId ?? null,
      },
    });
    return object;
  } catch {
    return null;
  }
}
