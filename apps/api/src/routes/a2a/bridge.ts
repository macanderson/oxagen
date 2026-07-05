import {
  streamAgentReply,
  selectModel,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfig,
} from "@oxagen/ai";
import { materializeTools, resolveAgentForA2A } from "@oxagen/agent";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertEvents } from "@oxagen/telemetry";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { CapabilityContext } from "@oxagen/oxagen";
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
    out.push({ role: m.role === "agent" ? "assistant" : "user", content: text });
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
    console.error(
      `[a2a.bridge] lifecycle event ${eventType} emit failed:`,
      err instanceof Error ? err.message : String(err),
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
    console.error(
      "[a2a.bridge] agent_executions insert failed:",
      err instanceof Error ? err.message : String(err),
    );
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
    console.error(
      "[a2a.bridge] agent_executions terminal update failed:",
      err instanceof Error ? err.message : String(err),
    );
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
    console.error(
      "[a2a.bridge] parentExecutionId lookup failed:",
      err instanceof Error ? err.message : String(err),
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
 * surface uses (streamAgentReply inside runInTenantScope). Token usage is
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
    ? await resolveAgentForA2A(ctx.workspaceId, skillId).catch((err: unknown) => {
        console.error(
          "[a2a.bridge] resolveAgentForA2A failed — falling back to generic chat:",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      })
    : null;

  // Cross-task lineage (spec §3.2): a referenced prior task's execution row
  // becomes this execution's parent, so agent.trace.get renders full A2A
  // conversation chains the same way it renders subagent fan-out chains.
  const parentExecutionId = await resolveParentExecutionId(ctx, inboundMessage);

  // fanoutRunId is always null today: CapabilityContext carries no
  // subagent_runs.id channel (agent.execute-subagent's ctx only threads
  // orgId/workspaceId/requestId/messageId — see
  // packages/inngest-functions/src/functions/agent.execute-subagent.ts), so
  // there is no non-fragile way yet to detect "this A2A task was opened from
  // inside a leased subagent run." Tracked as a follow-up wiring task rather
  // than invented here (spec §3.3) — null is the schema's documented default
  // for "not opened from a fanout run".
  const fanoutRunId: string | null = null;

  // Transition submitted → working; thread the resolved skill + (always-null,
  // see above) fanout linkage onto the task row in the same write.
  await updateTask(ctx, taskId, {
    state: "working",
    agentId: resolvedAgent?.id ?? null,
    fanoutRunId,
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
  const turnModel = selectModel(model ? { model } : {});

  try {
    const [{ tools: agentTools, nameMap: toolNameMap }, promptConfig] =
      await runInTenantScope(scope, () =>
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
    const skillInstructions = resolvedAgent?.activeVersion?.instructions?.trim();
    const baseline = skillInstructions
      ? `${chatBaseline}\n\n${skillInstructions}`
      : chatBaseline;

    const result = streamAgentReply({
      messages: toModelMessages(history),
      model: turnModel,
      tools: agentTools,
      system: resolvePrompt({
        key: "chat.system",
        baseline,
        config: promptConfig,
      }),
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: "api",
        messageId: ctx.requestId,
      },
    });

    for await (const raw of result.fullStream as AsyncIterable<unknown>) {
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
      } else if (pType === "finish") {
        const { totalUsage } = raw as {
          totalUsage?: { inputTokens?: number; outputTokens?: number };
        };
        inputTokens = totalUsage?.inputTokens ?? 0;
        outputTokens = totalUsage?.outputTokens ?? 0;
      } else if (pType === "error") {
        streamErrored = true;
        const errVal = (raw as { error?: unknown }).error;
        errorMessage =
          errVal instanceof Error
            ? errVal.message
            : typeof errVal === "string"
              ? errVal
              : "Agent stream error";
        console.error("[a2a.bridge] LLM stream error part:", errorMessage);
      }
    }
  } catch (err) {
    streamErrored = true;
    errorMessage = err instanceof Error ? err.message : "Agent execution failed";
    console.error("[a2a.bridge] task execution threw:", errorMessage);
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
