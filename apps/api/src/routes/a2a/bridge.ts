import {
  selectModel,
  modelIdOf,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfig,
} from "@oxagen/ai";
import { materializeTools, resolveAgentForA2A } from "@oxagen/agent";
import { createPlatformAgentAi } from "@oxagen/agent/adapters";
import { runCodingAgent, DEFAULT_MAX_AGENT_STEPS } from "@oxagen/agent-engine";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertEvents, captureError } from "@oxagen/telemetry";
import { schema, withTenantDb } from "@oxagen/database";
import { logger } from "../../middleware/logger";
import { and, eq } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  createTurnBudgetGuard,
  TURN_BUDGET_OFF,
  type TurnBudgetPolicy,
} from "@oxagen/billing";
import { budgetPolicyReadHandler } from "@oxagen/handlers/budget.policy.read";
import {
  recallWorkspaceMemoryMessage,
  createRecalledMemoryProvider,
} from "../v1/chat-memory";
import {
  getSkillId,
  type A2AArtifact,
  type A2AArtifactUpdateEvent,
  type A2AMessage,
  type A2APart,
  type A2AStatusUpdateEvent,
  type A2ATaskState,
} from "./protocol";
import { loadTask, updateTask, type A2ATaskRow } from "./task-store";
import { publish } from "./stream-registry";

/** Convert the budget.policy.read output to the engine's TurnBudgetPolicy shape. */
function turnBudgetPolicyFromSaved(saved: {
  enabled: boolean;
  limitUsd: number | null;
  mode: TurnBudgetPolicy["mode"];
  graceOveragePct: number;
}): TurnBudgetPolicy {
  return {
    enabled: saved.enabled,
    limitUsd: saved.limitUsd ?? 0,
    mode: saved.mode,
    graceOveragePct: saved.graceOveragePct,
  };
}

/** Concatenate an A2A message's text parts into a single string. */
export function messageText(message: A2AMessage): string {
  return message.parts
    .filter((p): p is Extract<A2APart, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Convert A2A conversation history to model messages (text parts only). */
function toModelMessages(history: A2AMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of history) {
    const text = messageText(m);
    if (!text) continue;
    out.push({
      role: m.role === "agent" ? "assistant" : "user",
      content: text,
    });
  }
  return out;
}

async function emitLifecycle(
  ctx: CapabilityContext,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId,
        event_type: eventType,
        source_system: `a2a:${ctx.surface}`,
        stream_offset: null,
        payload: JSON.stringify(payload),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    // Telemetry is best-effort — a ClickHouse hiccup must not fail the task.
    logger.warn(
      { err, eventType, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "[a2a.bridge] lifecycle event emit failed",
    );
  }
}

export interface RunA2ATaskArgs {
  ctx: CapabilityContext;
  /** The freshly-created task row (state 'submitted'). */
  task: A2ATaskRow;
  /** Full A2A conversation history for this contextId, oldest → newest. */
  history: A2AMessage[];
  /**
   * The inbound message that triggered this task run (the just-normalized
   * user message, before it was appended to history). Carries skill
   * addressing (`metadata.skillId` — spec §3.1) and cross-task lineage
   * (`referenceTaskIds` — spec §3.2), neither of which `history` alone
   * exposes cleanly to the bridge.
   */
  message: A2AMessage;
  /** Optional model override slug. */
  model?: string | null;
  /**
   * When present, incremental A2A events are pushed here (message/stream). When
   * absent, the task runs to completion and only the final row is returned
   * (message/send).
   */
  onEvent?: (event: A2AStatusUpdateEvent | A2AArtifactUpdateEvent) => void;
}

/**
 * Record one `agent_executions` row for this A2A task (spec §3.2). Best-effort
 * — Postgres is the operational record for the task itself (a2a_tasks), so a
 * lineage-insert hiccup must not fail the customer-facing A2A response; it is
 * logged so the missing audit/trace row is visible to monitoring.
 */
async function insertExecutionRow(args: {
  ctx: CapabilityContext;
  originId: string;
  agentId: string | null;
  agentVersionId: string | null;
  parentExecutionId: string | null;
  inputPayload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    return await runInTenantScope(
      { orgId: args.ctx.orgId, workspaceId: args.ctx.workspaceId },
      () =>
        withTenantDb(async (tx) => {
          const [row] = await tx
            .insert(schema.agentExecutions)
            .values({
              orgId: args.ctx.orgId,
              workspaceId: args.ctx.workspaceId,
              agentId: args.agentId,
              agentVersionId: args.agentVersionId,
              originType: "a2a",
              originId: args.originId,
              status: "running",
              inputPayload: args.inputPayload,
              startedAt: new Date(),
              parentExecutionId: args.parentExecutionId,
              createdByUserId: args.ctx.userId ?? null,
              updatedByUserId: args.ctx.userId ?? null,
            })
            .returning({ id: schema.agentExecutions.id });
          return row?.id ?? null;
        }),
    );
  } catch (err) {
    // Best-effort lineage row: log with context AND escalate via captureError so
    // a spike in dropped agent_executions inserts is alertable the same way every
    // other apps/api boundary is — a lost lineage row is a fleet-lineage hole.
    logger.warn(
      {
        err,
        orgId: args.ctx.orgId,
        workspaceId: args.ctx.workspaceId,
        originId: args.originId,
      },
      "[a2a.bridge] agent_executions insert failed",
    );
    captureError({
      error: err,
      source: "api",
      severity: "warn",
      orgId: args.ctx.orgId,
      workspaceId: args.ctx.workspaceId,
      requestId: args.ctx.requestId,
      context: "a2a.bridge: agent_executions insert failed",
    });
    return null;
  }
}

/** Update the terminal status/output of an A2A task's execution row. Best-effort (see insertExecutionRow). */
async function updateExecutionRow(args: {
  ctx: CapabilityContext;
  executionId: string;
  status: "completed" | "failed";
  outputPayload: Record<string, unknown> | null;
  failureReason: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  try {
    await runInTenantScope(
      { orgId: args.ctx.orgId, workspaceId: args.ctx.workspaceId },
      () =>
        withTenantDb((tx) =>
          tx
            .update(schema.agentExecutions)
            .set({
              status: args.status,
              outputPayload: args.outputPayload,
              failureReason: args.failureReason,
              completedAt: new Date(),
              latencyMs: args.latencyMs,
              inputTokens: args.inputTokens,
              outputTokens: args.outputTokens,
              updatedByUserId: args.ctx.userId ?? null,
            })
            .where(eq(schema.agentExecutions.id, args.executionId)),
        ),
    );
  } catch (err) {
    // Best-effort lineage update: log with context AND escalate via captureError
    // — a dropped terminal update leaves the execution row stuck in 'running'
    // with no token totals, undermining fleet lineage/audit.
    logger.warn(
      {
        err,
        orgId: args.ctx.orgId,
        workspaceId: args.ctx.workspaceId,
        executionId: args.executionId,
      },
      "[a2a.bridge] agent_executions terminal update failed",
    );
    captureError({
      error: err,
      source: "api",
      severity: "warn",
      orgId: args.ctx.orgId,
      workspaceId: args.ctx.workspaceId,
      requestId: args.ctx.requestId,
      executionId: args.executionId,
      context: "a2a.bridge: agent_executions terminal update failed",
    });
  }
}

/**
 * Resolve the `agent_executions.id` recorded for a prior A2A task, given its
 * internal `a2a_tasks.id` (NOT the wire taskId) — used to chain
 * `parentExecutionId` when `message.referenceTaskIds[0]` names an earlier
 * task (spec §3.2). Returns null (never throws) when the prior task never got
 * an execution row (e.g. it failed before the insert, or predates this
 * feature) — lineage is best-effort, not a hard dependency.
 */
async function findExecutionIdForTask(
  ctx: CapabilityContext,
  taskInternalId: string,
): Promise<string | null> {
  try {
    return await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        withTenantDb(async (tx) => {
          const [row] = await tx
            .select({ id: schema.agentExecutions.id })
            .from(schema.agentExecutions)
            .where(
              and(
                eq(schema.agentExecutions.orgId, ctx.orgId),
                eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
                eq(schema.agentExecutions.originType, "a2a"),
                eq(schema.agentExecutions.originId, taskInternalId),
              ),
            )
            .limit(1);
          return row?.id ?? null;
        }),
    );
  } catch (err) {
    logger.warn(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, taskInternalId },
      "[a2a.bridge] parentExecutionId lookup failed",
    );
    return null;
  }
}

/**
 * Resolve `message.referenceTaskIds[0]` (a prior task's wire taskId) to that
 * task's `agent_executions.id`, so the new execution can chain
 * `parentExecutionId` (spec §3.2). Falls back to null for anything that
 * doesn't resolve — an unknown, cross-workspace, or execution-less reference
 * is a no-op, never a thrown error.
 */
async function resolveParentExecutionId(
  ctx: CapabilityContext,
  message: A2AMessage,
): Promise<string | null> {
  const priorTaskId = message.referenceTaskIds?.[0];
  if (!priorTaskId) return null;
  const priorTask = await loadTask(ctx, priorTaskId);
  if (!priorTask) return null;
  return findExecutionIdForTask(ctx, priorTask.id);
}

/**
 * Run one A2A task by bridging to the same agent execution path the chat
 * surface uses — the shared coding engine (runCodingAgent) in workspace-optional
 * conversational mode, so the multi-step tool loop, invoke()-gated tools,
 * per-turn memory recall, and the USD budget guard all apply. Token usage is
 * metered automatically by @oxagen/ai; task lifecycle is emitted to ClickHouse
 * and persisted to Postgres. Returns the final task row.
 *
 * This is the single execution stack — it does NOT fork a second agent runtime.
 */
export async function runA2ATask(args: RunA2ATaskArgs): Promise<A2ATaskRow> {
  const { ctx, task, history, message: inboundMessage, model, onEvent } = args;
  const taskId = task.publicId;
  const contextId = task.contextId;
  const startedAt = Date.now();

  // Publish to any live `tasks/resubscribe` listener for this task id in
  // addition to (unchanged) the caller's own onEvent — a task started via
  // message/send has no onEvent, but a separate connection may already be
  // resubscribed to it, and message/stream's own onEvent keeps working too
  // (spec §3.4).
  const emit = (event: A2AStatusUpdateEvent | A2AArtifactUpdateEvent): void => {
    publish(taskId, event);
    onEvent?.(event);
  };

  const statusUpdate = (
    state: A2ATaskState,
    final: boolean,
    message?: A2AMessage,
  ): void => {
    emit({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state,
        ...(message ? { message } : {}),
        timestamp: new Date().toISOString(),
      },
      final,
    });
  };

  await emitLifecycle(ctx, "a2a.task.started", { taskId, contextId });

  // Skill-addressed routing (spec §3.1): message.metadata.skillId names a
  // workspace agent whose active-version instructions should layer over the
  // generic chat baseline. An unknown/inactive skillId (or none at all)
  // resolves to null here — resolveAgentForA2A never throws — so this always
  // falls back to today's generic behavior rather than failing the task.
  const skillId = getSkillId(inboundMessage);
  const resolvedAgent = skillId
    ? await resolveAgentForA2A(ctx.workspaceId, skillId).catch(
        (err: unknown) => {
          logger.warn(
            { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, skillId },
            "[a2a.bridge] resolveAgentForA2A failed — falling back to generic chat",
          );
          return null;
        },
      )
    : null;

  // Cross-task lineage (spec §3.2): a referenced prior task's execution row
  // becomes this execution's parent, so agent.trace.get renders full A2A
  // conversation chains the same way it renders subagent fan-out chains.
  const parentExecutionId = await resolveParentExecutionId(ctx, inboundMessage);

  // Transition submitted → working; thread the resolved skill onto the task
  // row in the same write. (The former fanout_run_id column was dropped in
  // 20260802140000 — it was never populated; subagent lineage is carried by
  // parentExecutionId above.)
  await updateTask(ctx, taskId, {
    state: "working",
    agentId: resolvedAgent?.id ?? null,
  });
  statusUpdate("working", false);

  const executionId = await insertExecutionRow({
    ctx,
    originId: task.id,
    agentId: resolvedAgent?.id ?? null,
    agentVersionId: resolvedAgent?.activeVersion?.id ?? null,
    parentExecutionId,
    inputPayload: {
      taskId,
      contextId,
      skillId: skillId ?? null,
      text: messageText(inboundMessage),
    },
  });

  const artifactId = crypto.randomUUID();
  let assistantText = "";
  let streamErrored = false;
  let errorMessage = "";
  let inputTokens = 0;
  let outputTokens = 0;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const modelId = modelIdOf(selectModel(model ? { model } : {}));

  // The current turn's text becomes the engine `instruction`; the rest of the
  // conversation is `history`. `history` already includes the inbound turn as
  // its last entry (the bridge appends before calling), so drop a trailing user
  // message that duplicates the instruction — the engine appends it itself.
  const instruction = messageText(inboundMessage);
  const engineHistory = toModelMessages(history);
  const lastHist = engineHistory[engineHistory.length - 1];
  const historyForEngine: ModelMessage[] =
    lastHist !== undefined &&
    lastHist.role === "user" &&
    lastHist.content === instruction
      ? engineHistory.slice(0, -1)
      : engineHistory;

  try {
    // Materialize tools + prompt config AND kick off deterministic memory recall
    // in ONE tenant scope so recall runs CONCURRENTLY with tool materialization
    // (no serial latency before the first token). The recalled block is injected
    // per-turn by the engine AFTER the cached system prefix (ADR-021 §2/§8).
    const [
      { tools: agentTools, nameMap: toolNameMap },
      promptConfig,
      recalled,
    ] = await runInTenantScope(scope, () =>
      Promise.all([
        materializeTools({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId ?? "",
          apiKeyId: ctx.apiKeyId,
          requestId: ctx.requestId,
          surface: "api",
          messageId: ctx.requestId,
          clientIp: ctx.clientIp,
        }),
        loadWorkspacePromptConfig(ctx.workspaceId).catch(() => ({})),
        recallWorkspaceMemoryMessage({
          query: instruction,
          executionRef: ctx.requestId,
          ctx,
        }),
      ]),
    );

    const chatBaseline = chatSystemPrompt({
      orgSlug: "",
      workspaceSlug: "",
      orgName: ctx.orgId,
      workspaceName: ctx.workspaceId,
    });
    // Layer the addressed skill's instructions under the chat baseline (spec
    // §3.1) — additive, never a replacement, so tool-calling/UI-render
    // contracts in the baseline always still apply.
    const skillInstructions =
      resolvedAgent?.activeVersion?.instructions?.trim();
    const baseline = skillInstructions
      ? `${chatBaseline}\n\n${skillInstructions}`
      : chatBaseline;

    // Per-turn dollar budget (OXA — turn-budget). A2A is non-interactive, so
    // resolve the caller's saved default only when a user is present (agent-to-
    // agent tasks carry no user ⇒ OFF), and treat prompt-mode as non-pausing:
    // onPause returns false (deny → stop) since there is no approver on the A2A
    // wire. Off-by-default ⇒ createTurnBudgetGuard returns undefined (unbounded).
    const turnBudgetPolicy: TurnBudgetPolicy = ctx.userId
      ? await budgetPolicyReadHandler({}, ctx)
          .then(turnBudgetPolicyFromSaved)
          // FAIL-OPEN but never silent: a persistent read failure disables
          // per-turn spend enforcement — that must be observable in logs.
          .catch((err) => {
            logger.warn(
              { err: String(err) },
              "[a2a] budget.policy.read failed — failing open to TURN_BUDGET_OFF",
            );
            return TURN_BUDGET_OFF;
          })
      : TURN_BUDGET_OFF;
    const budgetGuard = createTurnBudgetGuard(turnBudgetPolicy, modelId, {
      onStop: (verdict) => {
        statusUpdate("working", false, {
          kind: "message",
          role: "agent",
          messageId: crypto.randomUUID(),
          taskId,
          contextId,
          parts: [
            {
              kind: "text",
              text: `Per-turn budget reached ($${verdict.costUsd.toFixed(4)} of $${verdict.limitUsd.toFixed(2)}); stopping.`,
            },
          ],
        });
      },
      // No interactive approver on the A2A wire — deny (stop) rather than hang.
      onPause: () => false,
    });

    // Run the SAME coding engine the CLI + in-app chat use (runCodingAgent),
    // workspace-optional conversational mode: the multi-step tool loop
    // (`stopWhen`), invoke()-gated tools, per-turn memory recall, and the USD
    // budget guard now all apply. Raw AI-SDK parts are mapped to A2A artifact/
    // status events via `onStreamPart`, preserving the JSON-RPC wire format.
    const ai = createPlatformAgentAi(ctx, ctx.requestId, "api");

    const result = await runCodingAgent({
      ai,
      instruction,
      history: historyForEngine,
      system: resolvePrompt({
        key: "chat.system",
        baseline,
        config: promptConfig,
      }),
      model: modelId,
      // Runaway backstop for the agentic tool loop, NOT a functional limit.
      maxSteps: DEFAULT_MAX_AGENT_STEPS,
      // Byte-identical behaviour: no step retries / no overflow re-run — an
      // overflow surfaces via the catch as a task failure, as before.
      maxRetries: 0,
      maxOverflowRetries: 0,
      extraTools: agentTools,
      memory: createRecalledMemoryProvider({
        recalledPromise: Promise.resolve(recalled),
      }),
      budgetGuard,
      onStreamPart: (raw: unknown) => {
        const pType =
          typeof raw === "object" && raw !== null && "type" in raw
            ? String((raw as { type: unknown }).type)
            : undefined;
        if (pType === "text-delta") {
          const text = (raw as { text: string }).text;
          assistantText += text;
          // Stream incremental artifact chunks (append) for message/stream.
          emit({
            kind: "artifact-update",
            taskId,
            contextId,
            artifact: {
              artifactId,
              name: "response",
              parts: [{ kind: "text", text }],
            },
            append: true,
            lastChunk: false,
          });
        } else if (pType === "tool-call") {
          const { toolName } = raw as { toolName: string };
          const capability = toolNameMap[toolName] ?? toolName;
          // A progress heartbeat so streaming clients see tool activity.
          statusUpdate("working", false, {
            kind: "message",
            role: "agent",
            messageId: crypto.randomUUID(),
            taskId,
            contextId,
            parts: [{ kind: "text", text: `Using ${capability}…` }],
          });
        } else if (pType === "error") {
          // Defensive: the engine THROWS provider/stream errors to the catch
          // below rather than yielding an `error` part, but if one arrives here
          // mark the turn errored so it fails cleanly.
          streamErrored = true;
          const errVal = (raw as { error?: unknown }).error;
          errorMessage =
            errVal instanceof Error
              ? errVal.message
              : typeof errVal === "string"
                ? errVal
                : "Agent stream error";
          logger.warn(
            {
              errorMessage,
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              taskId,
            },
            "[a2a.bridge] LLM stream error part",
          );
        }
      },
    });

    // Authoritative token totals: the engine's summed per-step usage.
    inputTokens = result.usage.inputTokens ?? 0;
    outputTokens = result.usage.outputTokens ?? 0;
  } catch (err) {
    streamErrored = true;
    errorMessage =
      err instanceof Error ? err.message : "Agent execution failed";
    logger.warn(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, taskId },
      "[a2a.bridge] task execution threw",
    );
  }

  if (streamErrored) {
    const failed = await updateTask(ctx, taskId, {
      state: "failed",
      errorMessage,
    });
    statusUpdate("failed", true, {
      kind: "message",
      role: "agent",
      messageId: crypto.randomUUID(),
      taskId,
      contextId,
      parts: [{ kind: "text", text: errorMessage }],
    });
    await emitLifecycle(ctx, "a2a.task.failed", {
      taskId,
      contextId,
      error: errorMessage,
      durationMs: Date.now() - startedAt,
    });
    if (executionId) {
      await updateExecutionRow({
        ctx,
        executionId,
        status: "failed",
        outputPayload: null,
        failureReason: errorMessage,
        latencyMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
      });
    }
    return failed ?? task;
  }

  // Success — persist the final artifact + agent message, mark completed.
  const artifact: A2AArtifact = {
    artifactId,
    name: "response",
    parts: [{ kind: "text", text: assistantText }],
  };
  const agentMessage: A2AMessage = {
    kind: "message",
    role: "agent",
    messageId: crypto.randomUUID(),
    taskId,
    contextId,
    parts: [{ kind: "text", text: assistantText }],
  };

  const completed = await updateTask(ctx, taskId, {
    state: "completed",
    artifacts: [artifact],
    appendMessages: [agentMessage],
    statusMessage: agentMessage,
  });

  // Final artifact-update marking the last chunk, then the terminal status.
  emit({
    kind: "artifact-update",
    taskId,
    contextId,
    artifact,
    append: false,
    lastChunk: true,
  });
  statusUpdate("completed", true, agentMessage);

  await emitLifecycle(ctx, "a2a.task.completed", {
    taskId,
    contextId,
    inputTokens,
    outputTokens,
    durationMs: Date.now() - startedAt,
  });

  if (executionId) {
    await updateExecutionRow({
      ctx,
      executionId,
      status: "completed",
      outputPayload: { text: assistantText },
      failureReason: null,
      latencyMs: Date.now() - startedAt,
      inputTokens,
      outputTokens,
    });
  }

  return completed ?? task;
}
