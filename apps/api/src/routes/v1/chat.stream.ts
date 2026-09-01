import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  selectModel,
  supportsReasoning,
  modelIdOf,
  loadEffectiveModelDefaults,
  resolvePrompt,
  chatSystemPrompt,
  loadWorkspacePromptConfigSafe,
} from "@oxagen/ai";
import {
  materializeTools,
  createApprovalRequest,
  waitForApproval,
} from "@oxagen/agent";
import { createPlatformAgentAi } from "@oxagen/agent/adapters";
import { executeTurn, DEFAULT_MAX_AGENT_STEPS } from "@oxagen/agent-runner";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
// Per-turn dollar budget (OXA — turn-budget). The gate itself (policy shape,
// modes, the pure evaluator, createTurnBudgetGuard) lives in @oxagen/billing —
// this route only resolves the effective policy and wires the hooks to its own
// SSE/approval machinery.
import {
  createTurnBudgetGuard,
  formatBudgetUsd,
  governedBudgetFromRead,
  requestTurnBudgetSchema,
  resolveEffectiveTurnBudget,
  resolveTurnBudgetPolicy,
  turnBudgetPolicyFromSaved,
  TURN_BUDGET_OFF,
  type SavedWorkspaceGovernance,
  type TurnBudgetPolicy,
} from "@oxagen/billing";
import { budgetPolicyReadHandler } from "@oxagen/handlers/budget.policy.read";
import type { ModelMessage } from "ai";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
import {
  createApiStreamTranslator,
  type ApiStreamEvent,
} from "./chat-stream-translator";
import { recallWorkspaceMemoryMessage } from "./chat-memory";

const BodySchema = z.object({
  // Bound the message body — the shared per-message ingress cap (see
  // CHAT_CONTENT_MAX_CHARS in the chat.message.send contract) so every chat
  // surface rejects oversized prompts identically.
  content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
  conversationId: z.string().nullable().default(null),
  // Per-turn MCP server allowlist. When non-empty, only those servers' tools
  // are loaded for this turn. Omit or pass [] to load all workspace MCPs.
  activeServerIds: z.array(z.string()).optional().default([]),
  // Optional model overrides — omit to use workspace/user defaults.
  tier: z.enum(["fast", "balanced", "precise"]).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(["low", "medium", "high"]).nullable().default(null),
  // Per-turn dollar-budget override. `null`/omitted means "no override for
  // this turn" — the route falls back to the caller's saved default
  // (budget.policy.read). An explicit object always wins, including an
  // explicit `{ enabled: false }` that turns OFF a saved default for one
  // turn. Same schema + precedence as the app chat route (@oxagen/billing).
  budget: requestTurnBudgetSchema.nullable().default(null),
});

const HISTORY_LIMIT = 50;
const VALID_ROLES = new Set(["user", "assistant", "system"]);

export const chatStreamRoute = new Hono<AppEnv>();

// POST /:org_slug/:workspace_slug/chat/stream
//
// Streams the agent reply as text/event-stream (SSE). Body: { content,
// conversationId?, activeServerIds?, tier?, model?, effort?, budget? }.
// Each SSE line: `data: <JSON ApiStreamEvent>\n\n`
// Terminal: `event: done\ndata: [DONE]\n\n`
//
// Runs the SAME engine the CLI and in-app chat use, workspace-optional
// conversational mode — the multi-step tool loop (`stopWhen`), invoke()-gated
// tools, per-turn memory recall and the USD budget guard. Raw AI-SDK parts are
// forwarded to a stateful SSE translator
// via `onStreamPart` so the client wire protocol is byte-identical to the
// pre-engine single-`streamAgentReply` transport.
chatStreamRoute.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      400,
    );
  }

  const {
    content,
    conversationId,
    activeServerIds,
    tier,
    model,
    effort,
    budget,
  } = parsed.data;
  const ctx = capabilityContext(c);
  // A stable per-turn UUID: execution_step_id / reference_id in the metered AI
  // port, executionRef for memory recall, and messageId in telemetry.
  const messageId = ctx.requestId;
  const capCtx: CapabilityContext = { ...ctx, messageId };

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
    ...(resolvedModel
      ? { model: resolvedModel }
      : resolvedTier
        ? { tier: resolvedTier }
        : {}),
  });
  const modelId = modelIdOf(turnModel);
  const turnEffort = effort && supportsReasoning(modelId) ? effort : undefined;

  // Load conversation history for multi-turn context.
  let historyMessages: ModelMessage[] = [];
  if (conversationId) {
    const rows = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        withTenantDb((tx) =>
          tx
            .select({
              role: schema.messages.role,
              content: schema.messages.content,
            })
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
      .map((r) => ({
        role: r.role as "user" | "assistant" | "system",
        content: r.content,
      }))
      .reverse();
  }

  // The engine appends the current user message (`instruction`) itself, so the
  // history it receives must EXCLUDE it. Drop a trailing row that duplicates the
  // current turn (e.g. a concurrent persist wrote it) so the model never sees the
  // current turn twice.
  const lastHistory = historyMessages[historyMessages.length - 1];
  const alreadyInHistory =
    lastHistory !== undefined &&
    lastHistory.role === "user" &&
    lastHistory.content === content;
  const historyForEngine: ModelMessage[] = alreadyInHistory
    ? historyMessages.slice(0, -1)
    : historyMessages;

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
        qaAgent = {
          id: agentRow.id,
          activeVersionId: agentRow.activeVersionId,
        };
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
      let closed = false;
      function emit(event: ApiStreamEvent): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // Client disconnected — the controller is closed. Latch it so the
          // engine's synchronous onStreamPart taps become no-ops (a throw there
          // would be misclassified as a stream error and trigger a retry).
          closed = true;
        }
      }

      // Track turn start time for latency measurement.
      const turnStartMs = Date.now();
      const turnStartedAt = new Date();

      // Hoisted so the execution recording block can access it after persistence.
      let assistantMsgId: string | null = null;

      try {
        // Materialize tools + prompt config, AND kick off deterministic memory
        // recall — all inside ONE tenant scope so recall runs CONCURRENTLY with
        // tool materialization (no serial latency before the first token). The
        // recalled block is injected per-turn by the engine AFTER the cached
        // system prefix (ADR-021 §2/§8), never into the system block.
        const [
          { tools: agentTools, nameMap: toolNameMap, mutatingToolNames },
          promptConfig,
          recalledMemory,
        ] = await runInTenantScope(
          { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
          () =>
            Promise.all([
              materializeTools(
                {
                  orgId: ctx.orgId,
                  workspaceId: ctx.workspaceId,
                  userId: ctx.userId ?? "",
                  apiKeyId: ctx.apiKeyId,
                  requestId: ctx.requestId,
                  surface: "api",
                  messageId,
                  clientIp: ctx.clientIp,
                },
                {
                  serverAllowlist:
                    activeServerIds.length > 0
                      ? new Set(activeServerIds)
                      : undefined,
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
              loadWorkspacePromptConfigSafe(ctx.workspaceId),
              recallWorkspaceMemoryMessage({
                query: content,
                executionRef: messageId,
                ctx: capCtx,
              }),
            ]),
        );

        // Per-turn dollar budget (OXA — turn-budget). Precedence is identical
        // to the app chat route (the adapters are the SAME @oxagen/billing
        // module): an explicit per-turn `budget` in the request body always
        // wins (no DB round-trip); otherwise fall back to the caller's saved
        // default via budget.policy.read (user-scoped; direct handler call, no
        // kernel). A missing user (API-key-only auth) or a failed read
        // degrades to TURN_BUDGET_OFF so a broken preferences row never blocks
        // a turn. Workspace governance (OXA-2081) is read concurrently via
        // invoke() — the metering/IAM chokepoint, `surface: "agent"` because
        // the contract's surfaces are ["api","mcp","agent"] — and merged on
        // top by resolveEffectiveTurnBudget, so a workspace ceiling binds
        // API-key turns exactly like app turns. FAIL-OPEN but never silent: a
        // governance read failure warns and resolves to null (the member's
        // policy applies unchanged) — a broken governance row must never block
        // a turn from running.
        const readMemberPolicy = async (): Promise<TurnBudgetPolicy> => {
          if (budget) return resolveTurnBudgetPolicy(budget, TURN_BUDGET_OFF);
          if (!ctx.userId) return TURN_BUDGET_OFF;
          try {
            return turnBudgetPolicyFromSaved(
              await budgetPolicyReadHandler({}, capCtx),
            );
          } catch (err) {
            // FAIL-OPEN but never silent: a persistent read failure disables
            // per-turn spend enforcement — that must be observable in logs.
            console.warn(
              "[chat/stream] budget.policy.read failed — failing open to TURN_BUDGET_OFF:",
              String(err),
            );
            return TURN_BUDGET_OFF;
          }
        };
        const readWorkspaceGovernance = async () => {
          try {
            const raw = await invoke("get_budget_policy", {}, capCtx, {
              surface: "agent",
            });
            return governedBudgetFromRead(raw as SavedWorkspaceGovernance);
          } catch (err) {
            console.warn(
              "[chat/stream] workspace budget governance read failed — failing open to member policy:",
              String(err),
            );
            return null;
          }
        };
        const [memberTurnBudgetPolicy, workspaceBudgetGovernance] =
          await Promise.all([readMemberPolicy(), readWorkspaceGovernance()]);
        const turnBudgetPolicy: TurnBudgetPolicy = resolveEffectiveTurnBudget(
          memberTurnBudgetPolicy,
          null,
          workspaceBudgetGovernance,
        );

        // createTurnBudgetGuard returns undefined when the policy is off, so an
        // unbudgeted turn passes no guard at all (unbounded, byte-identical to
        // before this feature). The hooks are the ONLY surface-specific part of
        // enforcement — the policy shape, the mode ladder, and the pure evaluator
        // all live in @oxagen/billing.
        const budgetGuard = createTurnBudgetGuard(turnBudgetPolicy, modelId, {
          onWithinGrace: (verdict) => {
            emit({
              type: "budget-notice",
              state: "within_grace",
              costUsd: verdict.costUsd,
              limitUsd: verdict.limitUsd,
              mode: verdict.mode,
            });
          },
          onStop: (verdict) => {
            emit({
              type: "budget-notice",
              state: "stopped",
              costUsd: verdict.costUsd,
              limitUsd: verdict.limitUsd,
              mode: verdict.mode,
            });
          },
          // prompt mode: reuse the EXISTING tool-approval machinery (the same
          // approval-required SSE event materializeTools uses) rather than a
          // second pause protocol. createApprovalRequest/waitForApproval read/
          // write via withTenantDb, so re-enter the tenant scope here.
          onPause: async (verdict) => {
            const costLabel = formatBudgetUsd(verdict.costUsd);
            const limitLabel = formatBudgetUsd(verdict.limitUsd);
            const inputPreview = {
              costUsd: verdict.costUsd,
              limitUsd: verdict.limitUsd,
              message: `Per-turn budget reached: ${costLabel} of ${limitLabel}. Approve to continue for another ${limitLabel}.`,
            };
            const { approvalId } = await runInTenantScope(
              { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
              () =>
                createApprovalRequest({
                  orgId: ctx.orgId,
                  workspaceId: ctx.workspaceId,
                  messageId,
                  capabilityName: "budget.turn.continue",
                  inputPreview,
                  riskLevel: "low",
                }),
            );
            const expiresAt = new Date(
              Date.now() + 5 * 60 * 1000,
            ).toISOString();
            emit({
              type: "approval-required",
              approvalId,
              capability: "budget.turn.continue",
              inputPreview,
              riskLevel: "low",
              expiresAt,
            });
            const resolution = await waitForApproval(approvalId);
            return resolution.resolution === "approved";
          },
        });

        // Stateful SSE translator — the single source of truth for the part→SSE
        // mapping (byte-identical to the pre-engine transport) + per-step
        // execution collection.
        const translator = createApiStreamTranslator({ toolNameMap, emit });

        // Metered AI port (@oxagen/ai). Surface "api" so token usage/credits
        // attribute to the API surface, matching the prior telemetry.
        const ai = createPlatformAgentAi(capCtx, messageId, "api");

        const result = await executeTurn("api-chat", {
          ai,
          instruction: content,
          // The recalled-memory message rides history directly, in the exact
          // position the engine's MemoryProvider used to inject it — after the
          // cached system prefix, immediately before the instruction. The
          // provider-shaped adapter is gone (#1236): there is no mid-turn
          // recallContext() callback on any engine any more.
          history: recalledMemory
            ? [...historyForEngine, recalledMemory]
            : historyForEngine,
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
          model: modelId,
          ...(turnEffort ? { effort: turnEffort } : {}),
          // Runaway backstop for the agentic tool loop, NOT a functional limit.
          maxSteps: DEFAULT_MAX_AGENT_STEPS,
          // Byte-identical client behaviour: no step retries (a retry would
          // re-forward a step's already-streamed parts) and no context-overflow
          // re-run — an overflow surfaces via the catch as a single `error` event,
          // as it did before the engine unification.
          maxRetries: 0,
          maxOverflowRetries: 0,
          // No `workspace` ⇒ conversational mode: no filesystem tools; the
          // materialized invoke()-gated capability ToolSet is injected here.
          extraTools: agentTools,
          // Mutating capability aliases: the engine's read/write partitioning
          // input (the TS dispatch barrier before the cutover, Stella's
          // read_only bit after).
          mutatingToolNames,
          // Client-disconnect abort stops the loop.
          signal: c.req.raw.signal,
          onStreamPart: (part) => translator.onPart(part),
          budgetGuard,
        });

        const {
          assistantText,
          execution: collectedExecution,
          streamErrored,
        } = translator.finish();

        // ONE aggregated usage event from the engine's summed per-step usage —
        // same single event, same position (last before `[DONE]`), byte-identical
        // shape to the pre-engine single-`finish` usage. Credits are charged per
        // step inside the metered AI port; this is display-only.
        emit({
          type: "usage",
          usage: {
            promptTokens: result.usage.inputTokens ?? 0,
            completionTokens: result.usage.outputTokens ?? 0,
            totalTokens: result.usage.totalTokens ?? 0,
          },
        });

        // Persist user message + assistant reply for conversation threading.
        // Skip on a defensive mid-stream error part: the assistantText is
        // partial/untrustworthy and must not be written as a successful turn
        // (the engine normally THROWS such errors to the catch below instead).
        if (
          !streamErrored &&
          conversationId &&
          (assistantText.length > 0 || content.length > 0)
        ) {
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
                      metadata: { status: "complete", surface: "api" },
                      createdByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                      updatedByUserId: ctx.userId ?? ctx.apiKeyId ?? ctx.orgId,
                    })
                    .returning({ id: schema.messages.id });

                  if (assistantMsg) {
                    assistantMsgId = assistantMsg.id;
                    await tx
                      .update(schema.conversations)
                      .set({
                        activeLeafMessageId: assistantMsg.id,
                        updatedAt: new Date(),
                      })
                      .where(eq(schema.conversations.id, conversationId));
                  }
                }),
            );
          } catch (persistErr) {
            // Persistence failure must not corrupt the already-sent SSE response,
            // but it is silent data loss unless we log it. Surface to monitoring;
            // do not rethrow into the SSE stream.
            const message =
              persistErr instanceof Error
                ? persistErr.message
                : String(persistErr);
            console.error(
              `[chat.stream] message persistence failed for conversation ${conversationId} (org ${ctx.orgId}, workspace ${ctx.workspaceId}):`,
              message,
            );
          }
        }

        // Record agent execution for SOC 2 audit trail.
        if (qaAgent && conversationId && assistantMsgId) {
          try {
            await invoke(
              "get_message_execution",
              {
                messageId: assistantMsgId,
                agentId: qaAgent.id,
                agentVersionId: qaAgent.activeVersionId,
                originType: "chat",
                originId: assistantMsgId,
                status: "completed",
                inputPayload: { content, conversationId },
                outputPayload: {
                  text:
                    collectedExecution.inputTokens > 0 ||
                    collectedExecution.outputTokens > 0
                      ? "[streamed]"
                      : null,
                },
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
              { ...capCtx, surface: "api" as const },
              { surface: "api" },
            );
          } catch (execErr) {
            // Execution recording failure must not corrupt the already-sent SSE
            // response, but this is the SOC 2 audit trail (CC6/CC7) — a silent
            // gap is a compliance defect. Log so the missing audit record is
            // visible to monitoring; do not rethrow into the SSE stream.
            const message =
              execErr instanceof Error ? execErr.message : String(execErr);
            console.error(
              `[chat.stream] execution recording failed for message ${assistantMsgId} (org ${ctx.orgId}, workspace ${ctx.workspaceId}):`,
              message,
            );
          }
        }
      } catch (err) {
        // The engine THROWS on a provider/stream error, a context overflow (with
        // maxOverflowRetries: 0), or a client-disconnect abort. Skip persistence
        // (the assistantText is partial/untrustworthy) and surface a typed error.
        const message = err instanceof Error ? err.message : "Stream error";
        emit({ type: "error", message });
      } finally {
        try {
          controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
        } catch {
          // Controller may already be closed.
        }
        closed = true;
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
