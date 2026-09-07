import { Hono } from "hono";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import {
  selectModel,
  supportsReasoning,
  modelIdOf,
  loadEffectiveModelDefaults,
  resolvePrompt,
  loadWorkspacePromptConfigSafe,
  type ModelMessage,
} from "@oxagen/ai";
import {
  materializeTools,
  createApprovalRequest,
  waitForApproval,
  runGovernedTurn,
  buildChatSystemPrompt,
} from "@oxagen/agent";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
// Per-turn dollar budget + the pre-turn credit admission gate. Both live in
// @oxagen/billing so this route and the app's chat route admit and bound a turn
// by exactly the same rules — this surface only wires the hooks to its own SSE
// and approval machinery.
import {
  createTurnBudgetGuard,
  evaluateTurnCreditGate,
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
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
import {
  createApiStreamTranslator,
  type ApiStreamEvent,
} from "./chat-stream-translator";
import { recallWorkspaceMemoryMessage } from "./chat-memory";

// Request shape for POST /:org_slug/:workspace_slug/chat/stream.
//
// This is the ingress contract the surface has always published; every 400 a
// caller depends on — malformed JSON, a missing/empty message, an oversized
// body, a nonsense budget override — is defined here.
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
  // this turn" — the saved default applies. Same schema and precedence as the
  // app chat route (@oxagen/billing).
  budget: requestTurnBudgetSchema.nullable().default(null),
});

const HISTORY_LIMIT = 50;
const VALID_ROLES = new Set(["user", "assistant", "system"]);

export const chatStreamRoute = new Hono<AppEnv>();

/**
 * Resolve the org + workspace display names for the system prompt. Best-effort:
 * the prompt names the scope the agent is answering about, so a failed read
 * degrades to the URL slugs rather than failing the turn.
 */
async function resolveScopeNames(ctx: {
  orgId: string;
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
}): Promise<{ orgName: string; workspaceName: string }> {
  try {
    return await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () =>
        withTenantDb(async (tx) => {
          const [org] = await tx
            .select({ name: schema.organizations.name })
            .from(schema.organizations)
            .where(eq(schema.organizations.id, ctx.orgId))
            .limit(1);
          const [ws] = await tx
            .select({ name: schema.workspaces.name })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.id, ctx.workspaceId))
            .limit(1);
          return {
            orgName: org?.name ?? ctx.orgSlug,
            workspaceName: ws?.name ?? ctx.workspaceSlug,
          };
        }),
    );
  } catch {
    return { orgName: ctx.orgSlug, workspaceName: ctx.workspaceSlug };
  }
}

// POST /:org_slug/:workspace_slug/chat/stream
//
// Streams the governance agent's reply as text/event-stream (SSE). Body:
// { content, conversationId?, activeServerIds?, tier?, model?, effort?, budget? }.
// Each SSE line: `data: <JSON ApiStreamEvent>\n\n`
// Terminal: `event: done\ndata: [DONE]\n\n`
//
// ADR-041: the turn is `runGovernedTurn` from @oxagen/agent — one bounded,
// metered in-process loop over @oxagen/ai whose tools are materialised
// capability contracts dispatched through kernel.invoke(). There is no sandbox,
// no filesystem, no browser and no subagents behind it. This route is a THIN
// adapter over that loop: the same loop serves the app's chat route, and the
// two differ only in their wire format and what they persist.
//
// The raw AI-SDK parts are forwarded to ./chat-stream-translator, which is the
// single source of truth for this surface's SSE shapes and also collects the
// per-step execution record for the SOC 2 audit trail.
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
  // A stable per-turn UUID: execution_step_id / reference_id in the metered
  // @oxagen/ai call, executionRef for memory recall, and messageId in telemetry.
  const messageId = ctx.requestId;
  const capCtx: CapabilityContext = {
    ...ctx,
    messageId,
    executionStepId: messageId,
  };

  // ── Pre-turn credit admission gate ─────────────────────────────────────────
  // The top-level model call reaches @oxagen/ai directly, not through
  // invoke(), so without this a turn that calls no tool would skip the balance
  // check entirely and a suspended / depleted org would get a free model call.
  // Blocks only on the affirmative billing outcomes and fails OPEN on anything
  // else (see @oxagen/billing turn-credit-gate).
  const creditGate = await runInTenantScope(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    () => evaluateTurnCreditGate(ctx.orgId),
  );
  if (!creditGate.ok) {
    return c.json(
      { error: { code: creditGate.code, message: creditGate.message } },
      402,
    );
  }

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

  const orgSlug = c.req.param("org_slug") ?? "";
  const workspaceSlug = c.req.param("workspace_slug") ?? "";

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

  // The turn loop appends the current user message (`instruction`) itself, so
  // the history it receives must EXCLUDE it. Drop a trailing row that duplicates
  // the current turn (e.g. a concurrent persist wrote it) so the model never
  // sees the current turn twice.
  const lastHistory = historyMessages[historyMessages.length - 1];
  const alreadyInHistory =
    lastHistory !== undefined &&
    lastHistory.role === "user" &&
    lastHistory.content === content;
  const historyForTurn: ModelMessage[] = alreadyInHistory
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
          // translator's synchronous emits become no-ops (a throw there would
          // be misclassified as a stream error).
          closed = true;
        }
      }

      // Track turn start time for latency measurement.
      const turnStartMs = Date.now();
      const turnStartedAt = new Date();

      // Hoisted so the execution recording block can access it after persistence.
      let assistantMsgId: string | null = null;

      try {
        // Materialize tools + prompt config + scope names, AND kick off
        // deterministic memory recall — all inside ONE tenant scope so recall
        // runs CONCURRENTLY with tool materialization (no serial latency before
        // the first token). The recalled block is injected per-turn AFTER the
        // cached system prefix (ADR-021 §2/§8), never into the system block.
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

        const { orgName, workspaceName } = await resolveScopeNames({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgSlug,
          workspaceSlug,
        });

        // Per-turn dollar budget (OXA — turn-budget). Precedence is identical
        // to the app chat route (the adapters are the SAME @oxagen/billing
        // module): an explicit per-turn `budget` in the request body always
        // wins (no DB round-trip); otherwise fall back to the caller's saved
        // default via budget.policy.read (user-scoped; direct handler call, no
        // kernel). A missing user (API-key-only auth) or a failed read
        // degrades to TURN_BUDGET_OFF so a broken preferences row never blocks
        // a turn. Workspace governance is read concurrently via invoke() — the
        // metering/IAM chokepoint, `surface: "agent"` because the contract's
        // surfaces are ["api","mcp","agent"] — and merged on top by
        // resolveEffectiveTurnBudget, so a workspace ceiling binds API-key
        // turns exactly like app turns. FAIL-OPEN but never silent.
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
              "[chat.stream] budget.policy.read failed — failing open to TURN_BUDGET_OFF:",
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
              "[chat.stream] workspace budget governance read failed — failing open to member policy:",
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
        // unbudgeted turn passes no guard at all. The hooks are the ONLY
        // surface-specific part of enforcement — the policy shape, the mode
        // ladder, and the pure evaluator all live in @oxagen/billing.
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
        // mapping on this surface, plus the per-step execution collection.
        const translator = createApiStreamTranslator({ toolNameMap, emit });

        const turn = await runGovernedTurn({
          telemetry: {
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            surface: "api",
            messageId,
          },
          model: turnModel,
          // @oxagen/agent owns the governance agent's prompt — one baseline,
          // shared with the app surface. `chat.system` is append-only, so a
          // workspace can add instructions but never replace the governance
          // contract.
          system: resolvePrompt({
            key: "chat.system",
            baseline: buildChatSystemPrompt({
              orgSlug,
              workspaceSlug,
              orgName,
              workspaceName,
            }),
            config: promptConfig,
          }),
          history: historyForTurn,
          // The recalled-memory block rides as a volatile per-turn USER message
          // between history and the instruction — never in the cached system
          // prefix (ADR-021 §2/§8).
          contextMessages: [recalledMemory],
          instruction: content,
          tools: agentTools,
          mutatingToolNames,
          ...(turnEffort ? { effort: turnEffort } : {}),
          ...(budgetGuard !== undefined ? { budgetGuard } : {}),
          // Client-disconnect abort stops the loop.
          abortSignal: c.req.raw.signal,
        });

        for await (const part of turn.fullStream) {
          translator.onPart(part);
        }

        const { assistantText, execution: collectedExecution, streamErrored } =
          translator.finish();

        // ONE aggregated usage event for the turn, in the same position (last
        // before `[DONE]`) and the same shape the surface has always emitted.
        // Credits are charged inside @oxagen/ai's metered stream; this is the
        // display copy of the same totals.
        const usage = await turn.usage;
        emit({
          type: "usage",
          usage: {
            promptTokens: usage.inputTokens,
            completionTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
          },
        });

        // Persist user message + assistant reply for conversation threading.
        // Skip on a mid-stream error part: the assistantText is partial and
        // must not be written as a successful turn.
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
        // Reached on a materializeTools failure, an IAM/kernel panic, or a
        // client-disconnect abort thrown out of the stream iteration. Skip
        // persistence (the assistantText is partial/untrustworthy) and surface
        // a typed error event.
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
