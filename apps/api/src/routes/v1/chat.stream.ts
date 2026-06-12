import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  streamAgentReply,
  selectModel,
  supportsReasoning,
  modelIdOf,
  loadEffectiveModelDefaults,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfig,
} from "@oxagen/ai";
import { materializeTools, readWorkspaceContext, injectContext } from "@oxagen/agent";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen/kernel";
import type { ModelMessage } from "ai";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

const BodySchema = z.object({
  content: z.string().min(1),
  conversationId: z.string().nullable().default(null),
  // Per-turn MCP server allowlist. When non-empty, only those servers' tools
  // are loaded for this turn. Omit or pass [] to load all workspace MCPs.
  activeServerIds: z.array(z.string()).optional().default([]),
  // Optional model overrides — omit to use workspace/user defaults.
  tier: z.enum(["fast", "balanced", "precise"]).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(["low", "medium", "high"]).nullable().default(null),
});

const HISTORY_LIMIT = 50;
const VALID_ROLES = new Set(["user", "assistant", "system"]);

// Inline stream-part helpers (same logic as apps/app/.../stream-parts.ts).
function partType(p: unknown): string | undefined {
  return typeof p === "object" && p !== null && "type" in p
    ? String((p as { type: unknown }).type)
    : undefined;
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Tool execution failed";
}

// Minimal typed stream events emitted over SSE.
type ApiStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning-start"; reasoningId: string }
  | { type: "reasoning-delta"; reasoningId: string; text: string }
  | { type: "reasoning-end"; reasoningId: string; durationMs: number }
  | { type: "step-start"; stepIndex: number }
  | { type: "step-finish"; stepIndex: number }
  | { type: "tool-input-start"; toolCallId: string; capability: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | { type: "tool-call-start"; toolCallId: string; capability: string; inputPreview: unknown; riskLevel: string }
  | { type: "tool-call-end"; toolCallId: string; status: "completed" | "failed"; output?: unknown; errorReason?: string; durationMs: number }
  | { type: "approval-required"; approvalId: string; capability: string; inputPreview: unknown; riskLevel: string; expiresAt: string }
  | { type: "usage"; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }
  | { type: "error"; message: string };

// Collected token + step data returned by consumeStream for execution recording.
type CollectedExecutionToolCall = {
  toolCallId: string;
  toolName: string;
  inputPreview: unknown;
  output?: unknown;
  status: "completed" | "failed";
  durationMs: number;
};

type CollectedExecutionStep = {
  stepNumber: number;
  stepType: string;
  status: "completed";
  inputPayload: unknown;
  toolCalls: CollectedExecutionToolCall[];
  latencyMs: number;
};

type CollectedExecution = {
  inputTokens: number;
  outputTokens: number;
  steps: CollectedExecutionStep[];
};

type ConsumeStreamResult = {
  assistantText: string;
  execution: CollectedExecution;
};

// Consume the agent fullStream, emit SSE events, and return the accumulated
// assistant text plus collected execution metadata for persistence. Mirrors
// translateAgentStream in the app route but without component/render-directive
// handling (no React registry in the API).
async function consumeStream(
  fullStream: AsyncIterable<unknown>,
  toolNameMap: Record<string, string>,
  emit: (event: ApiStreamEvent) => void,
): Promise<ConsumeStreamResult> {
  let assistantText = "";
  const toolStartedAt: Record<string, number> = {};
  const reasoningStartedAt: Record<string, number> = {};
  let stepIndex = -1;

  // Execution collection state.
  const collectedSteps: CollectedExecutionStep[] = [];
  const stepStartedAt: Record<number, number> = {};
  // Per-step tool call accumulation (keyed by toolCallId → stepNumber).
  const toolCallToStep: Record<string, number> = {};
  const collectedToolCalls: Record<string, CollectedExecutionToolCall> = {};
  let collectedInputTokens = 0;
  let collectedOutputTokens = 0;

  for await (const raw of fullStream) {
    const pType = partType(raw);
    if (pType === "text-delta") {
      const text = (raw as { text: string }).text;
      assistantText += text;
      emit({ type: "text", text });
    } else if (pType === "reasoning-start") {
      const { id } = raw as { id: string };
      reasoningStartedAt[id] = Date.now();
      emit({ type: "reasoning-start", reasoningId: id });
    } else if (pType === "reasoning-delta") {
      const { id, text } = raw as { id: string; text: string };
      emit({ type: "reasoning-delta", reasoningId: id, text });
    } else if (pType === "reasoning-end") {
      const { id } = raw as { id: string };
      const durationMs = reasoningStartedAt[id] !== undefined
        ? Date.now() - (reasoningStartedAt[id] as number) : 0;
      emit({ type: "reasoning-end", reasoningId: id, durationMs });
    } else if (pType === "start-step") {
      stepIndex += 1;
      stepStartedAt[stepIndex] = Date.now();
      emit({ type: "step-start", stepIndex });
    } else if (pType === "finish-step") {
      if (stepIndex >= 0) {
        const latencyMs = stepStartedAt[stepIndex] !== undefined
          ? Date.now() - (stepStartedAt[stepIndex] as number) : 0;
        // Collect all tool calls that were emitted for this step.
        const stepToolCalls = Object.values(collectedToolCalls).filter(
          (tc) => toolCallToStep[tc.toolCallId] === stepIndex,
        );
        collectedSteps.push({
          stepNumber: stepIndex,
          stepType: "llm_turn",
          status: "completed",
          inputPayload: null,
          toolCalls: stepToolCalls,
          latencyMs,
        });
        emit({ type: "step-finish", stepIndex });
      }
    } else if (pType === "tool-input-start") {
      const { id, toolName } = raw as { id: string; toolName: string };
      emit({
        type: "tool-input-start",
        toolCallId: id,
        capability: toolNameMap[toolName] ?? toolName,
      });
    } else if (pType === "tool-input-delta") {
      const { id, delta } = raw as { id: string; delta: string };
      emit({ type: "tool-input-delta", toolCallId: id, delta });
    } else if (pType === "tool-call") {
      const { toolCallId, toolName, input } = raw as { toolCallId: string; toolName: string; input: unknown };
      toolStartedAt[toolCallId] = Date.now();
      // Associate this tool call with the current step.
      toolCallToStep[toolCallId] = stepIndex;
      collectedToolCalls[toolCallId] = {
        toolCallId,
        toolName,
        inputPreview: input,
        status: "completed",
        durationMs: 0,
      };
      emit({
        type: "tool-call-start",
        toolCallId,
        capability: toolNameMap[toolName] ?? toolName,
        inputPreview: input,
        riskLevel: "low",
      });
    } else if (pType === "tool-result") {
      const { toolCallId, output } = raw as { toolCallId: string; output: unknown };
      const durationMs = toolStartedAt[toolCallId] !== undefined
        ? Date.now() - (toolStartedAt[toolCallId] as number) : 0;
      if (collectedToolCalls[toolCallId]) {
        collectedToolCalls[toolCallId] = {
          ...collectedToolCalls[toolCallId] as CollectedExecutionToolCall,
          output,
          status: "completed",
          durationMs,
        };
      }
      emit({ type: "tool-call-end", toolCallId, status: "completed", output, durationMs });
    } else if (pType === "tool-error") {
      const { toolCallId, error } = raw as { toolCallId: string; error: unknown };
      const durationMs = toolStartedAt[toolCallId] !== undefined
        ? Date.now() - (toolStartedAt[toolCallId] as number) : 0;
      if (collectedToolCalls[toolCallId]) {
        collectedToolCalls[toolCallId] = {
          ...collectedToolCalls[toolCallId] as CollectedExecutionToolCall,
          status: "failed",
          durationMs,
        };
      }
      emit({ type: "tool-call-end", toolCallId, status: "failed", errorReason: errorMessageOf(error), durationMs });
    } else if (pType === "finish") {
      const { totalUsage } = raw as { totalUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } };
      collectedInputTokens = totalUsage.inputTokens ?? 0;
      collectedOutputTokens = totalUsage.outputTokens ?? 0;
      emit({
        type: "usage",
        usage: {
          promptTokens: collectedInputTokens,
          completionTokens: collectedOutputTokens,
          totalTokens: totalUsage.totalTokens ?? 0,
        },
      });
    } else if (pType === "error") {
      const errVal = (raw as { error?: unknown }).error;
      const message = errVal instanceof Error ? errVal.message
        : typeof errVal === "string" ? errVal : "Stream error";
      emit({ type: "text", text: `\n\n[Error: ${message}]` });
    }
  }

  return {
    assistantText,
    execution: {
      inputTokens: collectedInputTokens,
      outputTokens: collectedOutputTokens,
      steps: collectedSteps,
    },
  };
}

export const chatStreamRoute = new Hono<AppEnv>();

// POST /:org_slug/:workspace_slug/chat/stream
//
// Streams the agent reply as text/event-stream (SSE). Body: { content,
// conversationId?, activeServerIds?, tier?, model?, effort? }.
// Each SSE line: `data: <JSON ApiStreamEvent>\n\n`
// Terminal: `event: done\ndata: [DONE]\n\n`
chatStreamRoute.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, 400);
  }

  const { content, conversationId, activeServerIds, tier, model, effort } = parsed.data;
  const ctx = capabilityContext(c);

  // Resolve language model: explicit > tier > workspace/user defaults > system default.
  let resolvedModel = model;
  let resolvedTier = tier;
  if (!resolvedModel && !resolvedTier && ctx.userId) {
    try {
      const defaults = await loadEffectiveModelDefaults({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });
      resolvedModel = defaults.text.model;
      resolvedTier = defaults.text.tier;
    } catch {
      // Fall through to system default inside selectModel().
    }
  }
  const turnModel = selectModel({
    ...(resolvedModel ? { model: resolvedModel } : resolvedTier ? { tier: resolvedTier } : {}),
  });
  const turnEffort = effort && supportsReasoning(modelIdOf(turnModel)) ? effort : undefined;

  // Load knowledge-graph context (no-op seam until Neo4j is configured).
  const contextBlocks = await readWorkspaceContext({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId ?? "",
  });

  // Load conversation history for multi-turn context.
  let historyMessages: ModelMessage[] = [];
  if (conversationId) {
    const rows = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        withTenantDb((tx) =>
          tx
            .select({ role: schema.messages.role, content: schema.messages.content })
            .from(schema.messages)
            .where(
              and(
                eq(schema.messages.conversationId, conversationId),
                eq(schema.messages.orgId, ctx.orgId),
                eq(schema.messages.workspaceId, ctx.workspaceId),
              ),
            )
            .orderBy(desc(schema.messages.createdAt))
            .limit(HISTORY_LIMIT),
        ),
    );
    historyMessages = rows
      .filter((r) => VALID_ROLES.has(r.role) && r.content.trim().length > 0)
      .map((r) => ({ role: r.role as "user" | "assistant" | "system", content: r.content }))
      .reverse();
  }

  // Append current user message (guard against duplicate if already trailing).
  const lastHistory = historyMessages[historyMessages.length - 1];
  const alreadyInHistory =
    lastHistory !== undefined && lastHistory.role === "user" && lastHistory.content === content;
  const messagesWithCurrent: ModelMessage[] = alreadyInHistory
    ? historyMessages
    : [...historyMessages, { role: "user", content }];

  const coreMessages: ModelMessage[] = injectContext(messagesWithCurrent, contextBlocks);

  // Look up the qa-chat agent for execution recording (SOC 2 audit trail).
  // Graceful degradation: if not found, the stream still proceeds.
  type QaAgent = { id: string; activeVersionId: string };
  let qaAgent: QaAgent | null = null;
  if (conversationId) {
    try {
      const [agentRow] = await runInTenantScope(
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        () =>
          withTenantDb((tx) =>
            tx
              .select({
                id: schema.agents.id,
                activeVersionId: schema.agents.activeVersionId,
              })
              .from(schema.agents)
              .where(
                and(
                  eq(schema.agents.workspaceId, ctx.workspaceId),
                  eq(schema.agents.slug, "qa-chat"),
                ),
              )
              .limit(1),
          ),
      );
      if (agentRow?.activeVersionId) {
        qaAgent = { id: agentRow.id, activeVersionId: agentRow.activeVersionId };
      } else {
        console.warn(
          `[chat.stream] qa-chat agent not found or missing activeVersionId for workspace ${ctx.workspaceId} — execution will not be recorded`,
        );
      }
    } catch {
      // Non-fatal: agent lookup failure must not block the stream.
      console.warn(
        `[chat.stream] Failed to look up qa-chat agent for workspace ${ctx.workspaceId} — execution will not be recorded`,
      );
    }
  }

  const encoder = new TextEncoder();

  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: ApiStreamEvent): void {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      // Track turn start time for latency measurement.
      const turnStartMs = Date.now();
      const turnStartedAt = new Date();

      // Hoisted so the execution recording block can access it after persistence.
      let assistantMsgId: string | null = null;

      try {
        const [{ tools: agentTools, nameMap: toolNameMap }, promptConfig] =
          await runInTenantScope({ orgId: ctx.orgId, workspaceId: ctx.workspaceId }, () =>
            Promise.all([
              materializeTools(
                {
                  orgId: ctx.orgId,
                  workspaceId: ctx.workspaceId,
                  userId: ctx.userId ?? "",
                  apiKeyId: ctx.apiKeyId,
                  requestId: ctx.requestId,
                  surface: "api",
                  messageId: ctx.requestId,
                  clientIp: ctx.clientIp,
                },
                {
                  serverAllowlist: activeServerIds.length > 0 ? new Set(activeServerIds) : undefined,
                  onApprovalRequired: (approvalEvent) => {
                    emit({
                      type: "approval-required",
                      approvalId: approvalEvent.approvalId,
                      capability: approvalEvent.capability,
                      inputPreview: approvalEvent.inputPreview,
                      riskLevel: approvalEvent.riskLevel,
                      expiresAt: approvalEvent.expiresAt,
                    });
                  },
                },
              ),
              loadWorkspacePromptConfig(ctx.workspaceId).catch(() => ({})),
            ]),
          );

        const result = streamAgentReply({
          messages: coreMessages,
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
          ...(turnEffort ? { effort: turnEffort } : {}),
          telemetry: {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            surface: "api",
            messageId: ctx.requestId,
          },
        });

        const { assistantText, execution: collectedExecution } = await consumeStream(
          result.fullStream as AsyncIterable<unknown>,
          toolNameMap,
          emit,
        );

        // Persist user message + assistant reply for conversation threading.
        if (conversationId && (assistantText.length > 0 || content.length > 0)) {
          try {
            await runInTenantScope(
              { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
              () =>
                withTenantDb(async (tx) => {
                  // Persist user message (API callers don't have a separate
                  // sendMessageAction like the app, so we write it here).
                  await tx.insert(schema.messages).values({
                    orgId: ctx.orgId,
                    workspaceId: ctx.workspaceId,
                    conversationId,
                    role: "user",
                    content,
                    contentBlocks: [],
                    isActiveInBranch: true,
                    metadata: { surface: "api" },
                    createdByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                    updatedByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                  });

                  const [assistantMsg] = await tx
                    .insert(schema.messages)
                    .values({
                      orgId: ctx.orgId,
                      workspaceId: ctx.workspaceId,
                      conversationId,
                      role: "assistant",
                      content: assistantText,
                      contentBlocks: [],
                      isActiveInBranch: true,
                      metadata: { status: "complete", surface: "api" },
                      createdByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                      updatedByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                    })
                    .returning({ id: schema.messages.id });

                  if (assistantMsg) {
                    assistantMsgId = assistantMsg.id;
                    await tx
                      .update(schema.conversations)
                      .set({ activeLeafMessageId: assistantMsg.id, updatedAt: new Date() })
                      .where(eq(schema.conversations.id, conversationId));
                  }
                }),
            );
          } catch {
            // Persistence failure must not corrupt the already-sent SSE response.
          }
        }

        // Record agent execution for SOC 2 audit trail.
        // Only fires when: the qa-chat agent was found, a conversationId was used,
        // and the assistant message was persisted.
        if (qaAgent && conversationId && assistantMsgId) {
          try {
            await invoke(
              "chat.message.execution",
              {
                messageId: assistantMsgId,
                agentId: qaAgent.id,
                agentVersionId: qaAgent.activeVersionId,
                originType: "chat",
                originId: assistantMsgId,
                status: "completed",
                inputPayload: { content, conversationId },
                outputPayload: { text: collectedExecution.inputTokens > 0 || collectedExecution.outputTokens > 0 ? "[streamed]" : null },
                startedAt: turnStartedAt,
                completedAt: new Date(),
                latencyMs: Date.now() - turnStartMs,
                inputTokens: collectedExecution.inputTokens,
                outputTokens: collectedExecution.outputTokens,
                updateMessageMetadata: true,
                steps: collectedExecution.steps.map((s) => ({
                  stepNumber: s.stepNumber,
                  stepType: "llm_turn",
                  status: "completed" as const,
                  inputPayload: s.inputPayload,
                  latencyMs: s.latencyMs,
                  toolCalls: s.toolCalls.map((tc) => ({
                    toolName: tc.toolName,
                    toolType: "mcp",
                    requestPayload: tc.inputPreview,
                    responsePayload: tc.output,
                    status: tc.status,
                    latencyMs: tc.durationMs,
                  })),
                })),
              },
              { ...ctx, surface: "api" as const },
              { surface: "api" },
            );
          } catch {
            // Execution recording failure must not corrupt the already-sent SSE response.
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Stream error";
        emit({ type: "error", message });
      } finally {
        try {
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
        } catch {
          // Controller may already be closed.
        }
        controller.close();
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
});
