/**
 * One turn of the in-app agent, from the person's message to the persisted
 * reply (MC spec §4.4, §14.1; ADR-053). The `ask_assistant` handler runs it
 * to completion; the SSE route streams it. Both go through here, so the
 * order the gates run in is decided once:
 *
 *   funding source → credit gate → model → the conversation and the person's
 *   message → tools, prompt, recalled memory, budget → the run admitted in
 *   the ledger → the engine drives the turn → the reply persisted.
 *
 * `prepareAssistantTurn` runs the role gate and the first three and refuses
 * before anything is written, which is what lets the SSE route answer the
 * refusal instead of opening a stream. `run` does the rest.
 *
 * Every tool the model calls is materialised from a capability contract and
 * executed through `kernel.invoke()` with the person's own context; the
 * engine holds no credential (ADR-053 §1). A write that needs a person is
 * parked (`approvalMode: "park"`) and returned as the turn's card. The model
 * is shown the assistant's belt through `createToolBelt`; the engine is
 * declared every tool. The turn is a run in the ledger before the engine is
 * asked anything, and does not answer if it cannot be (`openAssistantRun`).
 */
import {
  loadEffectiveModelDefaults,
  loadWorkspacePromptConfigSafe,
  modelIdOf,
  resolveModelFundingSource,
  resolvePrompt,
  selectModel,
  supportsReasoning,
  type ModelFundingSource,
  type ModelMessage,
  type StreamAgentReplyArgs,
} from "@oxagen/ai";
import {
  createTurnBudgetGuard,
  evaluateTurnCreditGate,
  formatBudgetUsd,
  governedBudgetFromRead,
  resolveEffectiveTurnBudget,
  resolveTurnBudgetPolicy,
  turnBudgetPolicyFromSaved,
  TURN_BUDGET_OFF,
  type CreditGateDenyCode,
  type RequestTurnBudget,
  type SavedWorkspaceGovernance,
  type TurnBudgetPolicy,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityContext } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import {
  assistantAsk,
  type AssistantPageContext,
  type AssistantParkedCard,
} from "@oxagen/oxagen/contracts/assistant.ask";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import { workspaceBudgetPolicyRead } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { INTERACTIVE_AGENT_CAPABILITIES } from "@oxagen/oxagen/interactive-agent";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import { buildChatSystemPrompt } from "../system-prompt";
import { createApprovalRequest, waitForApproval } from "./approval";
import { recallWorkspaceMemoryMessage } from "./assistant-recall";
import { openAssistantRun, type AssistantRunSurface } from "./assistant-run";
import {
  DEFAULT_GOVERNED_TURN_MAX_STEPS,
  runGovernedTurn,
  type GovernedTurnUsage,
} from "./governed-turn";
import {
  materializeTools,
  type ApprovalRequiredEvent,
} from "./materialize-tools";
import { createToolBelt } from "./tool-belt";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { pkg: "agent.assistant-turn" },
});

/** Prior turns the transcript carries. */
const HISTORY_LIMIT = 50;
const VALID_ROLES = new Set(["user", "assistant", "system"]);
/** How long a "prompt"-mode budget approval waits on a person. */
const BUDGET_APPROVAL_TTL_MS = 5 * 60 * 1000;
/** The capability name the budget-continue approval is filed under. */
const BUDGET_CONTINUE_CAPABILITY = "budget.turn.continue";

/** The roles `ask_assistant` grants, read from its contract (INV-29). */
const ASSISTANT_ROLES = {
  org: allowedRoles(assistantAsk.defaultRoles.org),
  workspace: allowedRoles(assistantAsk.defaultRoles.workspace),
};

function allowedRoles(grants: Record<string, string | undefined>): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

export interface AssistantTurnRequest {
  /** The person's context: `userId` is required, a turn is always someone's. */
  ctx: CapabilityContext;
  /** `chat` for the app, `api-chat` for the API and MCP. */
  surface: AssistantRunSurface;
  orgSlug: string;
  workspaceSlug: string;
  conversationId: string | null;
  content: string;
  pageContext: AssistantPageContext | null;
  /** Per-turn MCP server allowlist; empty loads every workspace server. */
  activeServerIds?: readonly string[];
  tier?: "fast" | "balanced" | "precise" | null;
  model?: string | null;
  effort?: "low" | "medium" | "high" | null;
  budget?: RequestTurnBudget | null;
}

export interface BudgetNotice {
  state: "within_grace" | "stopped";
  costUsd: number;
  limitUsd: number;
  mode: string;
}

/** What a streaming surface listens to while the turn runs. */
export interface AssistantTurnHooks {
  /** Every AI-SDK-shaped part of the turn, as the translators read them. */
  onPart?: (part: unknown) => void;
  onApprovalRequired?: (event: ApprovalRequiredEvent) => void;
  onBudgetNotice?: (notice: BudgetNotice) => void;
  /** The run the turn was admitted as, before the engine is asked anything. */
  onRun?: (run: { runId: string }) => void;
  /**
   * The model-facing alias → capability name map of the materialised tools,
   * before the first part: a surface's translator names tool calls by the
   * capability, and parts carry the alias.
   */
  onTools?: (nameMap: Record<string, string>) => void;
  /** The turn's aggregated token usage, once, before the reply is persisted. */
  onUsage?: (usage: GovernedTurnUsage) => void;
  /** Client disconnect; cancels the turn on the engine. */
  abortSignal?: AbortSignal;
}

export interface AssistantTurnResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  /** `arun_…` */
  runId: string;
  reply: string;
  parkedCard: AssistantParkedCard | null;
}

/** The credit gate said no. Surfaces answer 402 with the code and the message. */
export class AssistantTurnRefusedError extends Error {
  override readonly name = "AssistantTurnRefusedError";
  constructor(
    readonly code: CreditGateDenyCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The turn needs a person. A session carries one; an API key asks as the
 * person who created the key, and a key whose creator is not recorded (a key
 * minted by a process, or before creators were kept) cannot ask.
 */
export class AssistantTurnNeedsUserError extends Error {
  override readonly name = "AssistantTurnNeedsUserError";
  readonly code = "assistant_needs_user" as const;
  constructor() {
    super("the assistant answers a person; the caller has no user");
  }
}

export interface PreparedAssistantTurn {
  run(hooks?: AssistantTurnHooks): Promise<AssistantTurnResult>;
}

/**
 * Check the person may ask, resolve who pays, pass the credit gate and pick
 * the model. Refuses before anything is written.
 */
export async function prepareAssistantTurn(
  request: AssistantTurnRequest,
): Promise<PreparedAssistantTurn> {
  const scope = {
    orgId: request.ctx.orgId,
    workspaceId: request.ctx.workspaceId,
  };
  const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope(scope, fn);
  // The person asking: the signed-in user, or the creator of the API key
  // (resolveActingUserId, apps/app/ARCHITECTURE.md §9). The kernel's IAM check
  // allows every capability for a non-enterprise organisation, so the
  // contract's roles are checked here, on every adapter, for that person.
  const userId = await inScope(async () => {
    const actingUserId = await resolveActingUserId(request.ctx);
    if (!actingUserId) throw new AssistantTurnNeedsUserError();
    await assertOrgRole(
      { ...request.ctx, userId: actingUserId },
      ASSISTANT_ROLES,
    );
    return actingUserId;
  });
  // Every gate, tool call and record of the turn is the person's, so the
  // context the turn runs on names them even when the request came by key.
  const ctx: CapabilityContext = { ...request.ctx, userId };
  const personRequest: AssistantTurnRequest = { ...request, ctx };

  // Who pays for this turn's tokens, resolved once and handed to the gate,
  // the model and the turn so the three cannot disagree (ADR-053 §2). A
  // failed read is not caught: answering "platform" for it would move an
  // organisation with its own key onto Oxagen's billed key for an outage.
  const funding = await inScope(() => resolveModelFundingSource(ctx.orgId));

  const gate = await inScope(() =>
    evaluateTurnCreditGate(ctx.orgId, { fundedBy: funding.fundedBy }),
  );
  if (!gate.ok) throw new AssistantTurnRefusedError(gate.code, gate.message);

  let resolvedModel = request.model ?? null;
  let resolvedTier = request.tier ?? null;
  if (!resolvedModel && !resolvedTier) {
    try {
      const defaults = await loadEffectiveModelDefaults({
        userId,
        workspaceId: ctx.workspaceId,
      });
      resolvedModel = defaults.text.model;
      resolvedTier = defaults.text.tier;
    } catch {
      // The system default inside selectModel.
    }
  }
  const turnModel = selectModel({
    ...(resolvedModel
      ? { model: resolvedModel }
      : resolvedTier
        ? { tier: resolvedTier }
        : {}),
    ...(funding.fundedBy === "org" ? { credential: funding.credential } : {}),
  });
  const modelId = modelIdOf(turnModel);
  const effort =
    request.effort && supportsReasoning(modelId) ? request.effort : undefined;
  logger.info(
    {
      ...scope,
      requestId: ctx.requestId,
      modelId,
      fundedBy: funding.fundedBy,
      ...(funding.fundedBy === "org" ? { keyHint: funding.keyHint } : {}),
    },
    "assistant turn model",
  );

  return {
    run: (hooks = {}) =>
      runPreparedTurn({
        request: personRequest,
        userId,
        funding,
        turnModel,
        modelId,
        tier: resolvedTier,
        effort,
        hooks,
      }),
  };
}

interface PreparedInputs {
  request: AssistantTurnRequest;
  userId: string;
  funding: ModelFundingSource;
  turnModel: NonNullable<StreamAgentReplyArgs["model"]>;
  modelId: string;
  tier: "fast" | "balanced" | "precise" | null;
  effort: "low" | "medium" | "high" | undefined;
  hooks: AssistantTurnHooks;
}

async function runPreparedTurn(
  p: PreparedInputs,
): Promise<AssistantTurnResult> {
  const { request, userId, funding, hooks } = p;
  const { ctx } = request;
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const inScope = <T>(fn: () => Promise<T>): Promise<T> =>
    runInTenantScope(scope, fn);
  // The conversation and the person's message, before anything else is
  // spent: a turn that fails after this leaves the question on the record.
  const { conversationId, userMessageId, history } = await inScope(() =>
    withTenantDb((tx) =>
      appendUserMessage(tx, scope, userId, request, p.request.surface),
    ),
  );
  // The person's message names the turn everywhere: `token_usage`, the
  // approval rows' message id (which `resolve_approval` follows back to the
  // person who asked), the memory recall's execution ref.
  const messageId = userMessageId;
  const capCtx: CapabilityContext = {
    ...ctx,
    messageId,
    executionStepId: messageId,
  };

  const parked: AssistantParkedCard[] = [];
  const onApprovalRequired = (event: ApprovalRequiredEvent): void => {
    if (event.capability !== BUDGET_CONTINUE_CAPABILITY) {
      parked.push({
        approvalId: event.approvalId,
        capability: event.capability,
        expiresAt: event.expiresAt,
      });
    }
    hooks.onApprovalRequired?.(event);
  };

  const [materialised, promptConfig, recalledMemory] = await inScope(() =>
    Promise.all([
      materializeTools(capCtx, {
        serverAllowlist:
          request.activeServerIds && request.activeServerIds.length > 0
            ? new Set(request.activeServerIds)
            : undefined,
        onApprovalRequired,
        approvalMode: "park",
      }),
      loadWorkspacePromptConfigSafe(ctx.workspaceId),
      recallWorkspaceMemoryMessage({
        query: request.content,
        executionRef: messageId,
        ctx: capCtx,
      }),
    ]),
  );
  hooks.onTools?.(materialised.nameMap);
  const names = await resolveScopeNames(scope, request);

  const budgetPolicy = await resolveBudgetPolicy(request, capCtx);
  const budgetGuard = createTurnBudgetGuard(budgetPolicy, p.modelId, {
    onWithinGrace: (verdict) =>
      hooks.onBudgetNotice?.({
        state: "within_grace",
        costUsd: verdict.costUsd,
        limitUsd: verdict.limitUsd,
        mode: verdict.mode,
      }),
    onStop: (verdict) =>
      hooks.onBudgetNotice?.({
        state: "stopped",
        costUsd: verdict.costUsd,
        limitUsd: verdict.limitUsd,
        mode: verdict.mode,
      }),
    // "prompt" mode reuses the approval machinery: one pause protocol.
    onPause: async (verdict) => {
      const inputPreview = {
        costUsd: verdict.costUsd,
        limitUsd: verdict.limitUsd,
        message: `Per-turn budget reached: ${formatBudgetUsd(verdict.costUsd)} of ${formatBudgetUsd(verdict.limitUsd)}. Approve to continue for another ${formatBudgetUsd(verdict.limitUsd)}.`,
      };
      const { approvalId } = await inScope(() =>
        createApprovalRequest({
          ...scope,
          messageId,
          capabilityName: BUDGET_CONTINUE_CAPABILITY,
          inputPreview,
          riskLevel: "low",
        }),
      );
      onApprovalRequired({
        approvalId,
        capability: BUDGET_CONTINUE_CAPABILITY,
        inputPreview,
        riskLevel: "low",
        expiresAt: new Date(Date.now() + BUDGET_APPROVAL_TTL_MS).toISOString(),
      });
      const resolution = await waitForApproval(approvalId);
      return resolution.resolution === "approved";
    },
  });

  // The belt: the interactive agent's own capabilities are pinned, the rest
  // is reachable through search_tools and load_tools (#2611).
  const pinnedCapabilities = new Set<string>(INTERACTIVE_AGENT_CAPABILITIES);
  const belt = createToolBelt({
    tools: materialised.tools,
    pinned: Object.entries(materialised.nameMap)
      .filter(([, real]) => pinnedCapabilities.has(real))
      .map(([alias]) => alias),
    modelId: p.modelId,
  });

  // The run, before the engine. A refusal here is the turn's answer.
  const run = await openAssistantRun({
    ...scope,
    userId,
    surface: request.surface,
    instruction: request.content,
    maxSteps: DEFAULT_GOVERNED_TURN_MAX_STEPS,
  });
  hooks.onRun?.({ runId: run.runPublicId });

  const turn = await runGovernedTurn({
    telemetry: {
      ...scope,
      surface: request.surface === "chat" ? "app" : "api",
      messageId,
    },
    model: p.turnModel,
    ...(p.tier ? { tier: p.tier } : {}),
    ...(funding.fundedBy === "org" ? { credential: funding.credential } : {}),
    governance: { ...materialised.governance, ...belt.governance },
    principal: userId,
    system: resolvePrompt({
      key: "chat.system",
      baseline: buildChatSystemPrompt({
        orgSlug: request.orgSlug,
        workspaceSlug: request.workspaceSlug,
        orgName: names.orgName,
        workspaceName: names.workspaceName,
      }),
      config: promptConfig,
    }),
    history,
    contextMessages: [pageContextMessage(request.pageContext), recalledMemory],
    instruction: request.content,
    tools: belt.tools,
    modelTools: belt.modelTools,
    mutatingToolNames: materialised.mutatingToolNames,
    ...(p.effort ? { effort: p.effort } : {}),
    ...(budgetGuard !== undefined ? { budgetGuard } : {}),
    fundedBy: funding.fundedBy,
    ...(hooks.abortSignal ? { abortSignal: hooks.abortSignal } : {}),
    ledger: run,
  });

  let streamError: { error: unknown } | null = null;
  for await (const part of turn.fullStream) {
    if ((part as { type?: string }).type === "error") {
      streamError ??= { error: (part as { error?: unknown }).error };
    }
    hooks.onPart?.(part);
  }
  if (streamError) {
    // A stream that carried an error never completed, and nothing of it is
    // saved as a reply. `finalText` rejects with the failure that ended the
    // turn (an engine failure, a receipt that could not be written); a turn
    // the engine reports aborted (a budget stop, a client abort) resolves it,
    // and the error part is the failure. The question stays on the record.
    await turn.finalText;
    throw streamError.error;
  }
  const [reply, usage] = await Promise.all([turn.finalText, turn.usage]);
  hooks.onUsage?.(usage);

  const assistantMessageId = await inScope(() =>
    withTenantDb((tx) =>
      appendAssistantMessage(tx, scope, userId, conversationId, reply, {
        surface: request.surface,
        runId: run.runPublicId,
      }),
    ),
  );

  return {
    conversationId,
    userMessageId,
    assistantMessageId,
    runId: run.runPublicId,
    reply,
    parkedCard: parked[0] ?? null,
  };
}

type Tx = Parameters<Parameters<typeof withTenantDb>[0]>[0];
type Scope = { orgId: string; workspaceId: string };

/**
 * Resolve or open the conversation and append the person's message, then
 * load the prior turns as the transcript, newest last, without the message
 * just written.
 */
async function appendUserMessage(
  tx: Tx,
  scope: Scope,
  userId: string,
  request: AssistantTurnRequest,
  surface: AssistantRunSurface,
): Promise<{
  conversationId: string;
  userMessageId: string;
  history: ModelMessage[];
}> {
  let conversationId = request.conversationId;
  if (conversationId) {
    const [existing] = await tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.id, conversationId),
          eq(schema.conversations.orgId, scope.orgId),
          eq(schema.conversations.workspaceId, scope.workspaceId),
        ),
      )
      .limit(1);
    if (!existing) throw new ConversationNotFoundError(conversationId);
  } else {
    const [created] = await tx
      .insert(schema.conversations)
      .values({
        ...scope,
        userId,
        title: null,
        status: "active",
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({ id: schema.conversations.id });
    if (!created) throw new Error("conversation insert returned no row");
    conversationId = created.id;
  }

  const rows = await tx
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.orgId, scope.orgId),
        eq(schema.messages.workspaceId, scope.workspaceId),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(HISTORY_LIMIT);
  const history: ModelMessage[] = rows
    .filter((r) => VALID_ROLES.has(r.role) && r.content.trim().length > 0)
    .map((r) => ({
      role: r.role as "user" | "assistant" | "system",
      content: r.content,
    }))
    .reverse();

  const [userMessage] = await tx
    .insert(schema.messages)
    .values({
      ...scope,
      conversationId,
      role: "user",
      content: request.content,
      contentBlocks: [],
      metadata: {
        surface,
        ...(request.pageContext ? { pageContext: request.pageContext } : {}),
      },
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning({ id: schema.messages.id });
  if (!userMessage) throw new Error("message insert returned no row");
  return { conversationId, userMessageId: userMessage.id, history };
}

async function appendAssistantMessage(
  tx: Tx,
  scope: Scope,
  userId: string,
  conversationId: string,
  reply: string,
  metadata: { surface: AssistantRunSurface; runId: string },
): Promise<string> {
  const [assistantMessage] = await tx
    .insert(schema.messages)
    .values({
      ...scope,
      conversationId,
      role: "assistant",
      content: reply,
      contentBlocks: [],
      metadata: { status: "complete", ...metadata },
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning({ id: schema.messages.id });
  if (!assistantMessage) throw new Error("message insert returned no row");
  await tx
    .update(schema.conversations)
    .set({ activeLeafMessageId: assistantMessage.id, updatedAt: new Date() })
    .where(eq(schema.conversations.id, conversationId));
  return assistantMessage.id;
}

/** The conversation the caller named is not in this workspace. */
export class ConversationNotFoundError extends Error {
  override readonly name = "ConversationNotFoundError";
  readonly code = "not_found" as const;
  constructor(readonly conversationId: string) {
    super(`conversation ${conversationId} is not in this workspace`);
  }
}

/**
 * The org and workspace names for the system prompt. A failed read degrades
 * to the slugs: the prompt names the scope the agent answers about.
 */
async function resolveScopeNames(
  scope: Scope,
  request: Pick<AssistantTurnRequest, "orgSlug" | "workspaceSlug">,
): Promise<{ orgName: string; workspaceName: string }> {
  try {
    return await runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const [org] = await tx
          .select({ name: schema.organizations.name })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, scope.orgId))
          .limit(1);
        const [ws] = await tx
          .select({ name: schema.workspaces.name })
          .from(schema.workspaces)
          .where(eq(schema.workspaces.id, scope.workspaceId))
          .limit(1);
        return {
          orgName: org?.name ?? request.orgSlug,
          workspaceName: ws?.name ?? request.workspaceSlug,
        };
      }),
    );
  } catch {
    return { orgName: request.orgSlug, workspaceName: request.workspaceSlug };
  }
}

/**
 * The per-turn dollar budget: an explicit override on the request wins;
 * otherwise the person's saved default, with the workspace's governance
 * merged on top. Both reads fail open to no budget, never silently.
 */
async function resolveBudgetPolicy(
  request: AssistantTurnRequest,
  capCtx: CapabilityContext,
): Promise<TurnBudgetPolicy> {
  const member = async (): Promise<TurnBudgetPolicy> => {
    if (request.budget)
      return resolveTurnBudgetPolicy(request.budget, TURN_BUDGET_OFF);
    try {
      const saved = await invoke(budgetPolicyRead.name, {}, capCtx, {
        surface: "agent",
      });
      return turnBudgetPolicyFromSaved(budgetPolicyRead.output.parse(saved));
    } catch (err) {
      logger.warn(
        { err },
        "get_user_budget failed; the turn runs without a member budget",
      );
      return TURN_BUDGET_OFF;
    }
  };
  const workspace = async () => {
    try {
      const raw = await invoke(workspaceBudgetPolicyRead.name, {}, capCtx, {
        surface: "agent",
      });
      return governedBudgetFromRead(raw as SavedWorkspaceGovernance);
    } catch (err) {
      logger.warn(
        { err },
        "get_budget_policy failed; the turn runs on the member budget",
      );
      return null;
    }
  };
  const [memberPolicy, governance] = await Promise.all([member(), workspace()]);
  return resolveEffectiveTurnBudget(memberPolicy, null, governance);
}

/** Where the person is, as a volatile context message the model reads once. */
function pageContextMessage(
  pageContext: AssistantPageContext | null,
): ModelMessage | null {
  if (!pageContext) return null;
  const where = pageContext.entityId
    ? `${pageContext.route} (${pageContext.entityId})`
    : pageContext.route;
  return {
    role: "user",
    content: `(System-injected context — NOT user input.) The person is looking at: ${where} · workspace ${pageContext.workspaceSlug} of ${pageContext.orgSlug}.`,
  };
}
