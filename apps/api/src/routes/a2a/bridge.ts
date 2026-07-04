import {
  streamAgentReply,
  selectModel,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfig,
} from "@oxagen/ai";
import { materializeTools } from "@oxagen/agent";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertEvents } from "@oxagen/telemetry";
import type { ModelMessage } from "ai";
import type { CapabilityContext } from "@oxagen/oxagen";
import {
  type A2AArtifact,
  type A2AArtifactUpdateEvent,
  type A2AMessage,
  type A2APart,
  type A2AStatusUpdateEvent,
  type A2ATaskState,
} from "./protocol";
import { updateTask, type A2ATaskRow } from "./task-store";

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
 * Run one A2A task by bridging to the same agent execution path the chat
 * surface uses (streamAgentReply inside runInTenantScope). Token usage is
 * metered automatically by @oxagen/ai; task lifecycle is emitted to ClickHouse
 * and persisted to Postgres. Returns the final task row.
 *
 * This is the single execution stack — it does NOT fork a second agent runtime.
 */
export async function runA2ATask(args: RunA2ATaskArgs): Promise<A2ATaskRow> {
  const { ctx, task, history, model, onEvent } = args;
  const taskId = task.publicId;
  const contextId = task.contextId;
  const startedAt = Date.now();

  const statusUpdate = (
    state: A2ATaskState,
    final: boolean,
    message?: A2AMessage,
  ): void => {
    onEvent?.({
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

  // Transition submitted → working.
  await updateTask(ctx, taskId, { state: "working" });
  statusUpdate("working", false);

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

    const result = streamAgentReply({
      messages: toModelMessages(history),
      model: turnModel,
      tools: agentTools,
      system: resolvePrompt({
        key: "chat.system",
        baseline: chatSystemPrompt({
          orgSlug: "",
          workspaceSlug: "",
          orgName: ctx.orgId,
          workspaceName: ctx.workspaceId,
        }),
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
        onEvent?.({
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
  onEvent?.({
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

  return completed ?? task;
}
