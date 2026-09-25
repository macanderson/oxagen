/**
 * One turn of the in-app agent, from the person's message to the persisted
 * reply (MC spec §4.4, §14.1; ADR-053). The `ask_assistant` handler runs it
 * to completion; the SSE route streams it. Both go through here, so the
 * order the gates run in is decided once:
 *
 *   the assistant's kill switch → funding source → credit gate → model → the
 *   conversation and the person's message → tools, prompt, recalled memory,
 *   budget → the run admitted in the ledger → the engine drives the turn →
 *   the reply persisted.
 *
 * `prepareAssistantTurn` runs the role gate and the first four and refuses
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
  resolveModelIdentity,
  selectModel,
  supportsReasoning,
  type ModelFundingSource,
  type ModelIdentity,
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
  type AssistantGoal,
  type AssistantPageContext,
  type AssistantParkedCard,
} from "@oxagen/oxagen/contracts/assistant.ask";
import { budgetPolicyRead } from "@oxagen/oxagen/contracts/budget.policy.read";
import {
  chatMessageExecution,
  type ChatMessageExecutionInput,
} from "@oxagen/oxagen/contracts/chat.message.execution";
import { workspaceBudgetPolicyRead } from "@oxagen/oxagen/contracts/workspace.budget_policy.read";
import { INTERACTIVE_AGENT_CAPABILITIES } from "@oxagen/oxagen/interactive-agent";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, desc, eq } from "drizzle-orm";
import pino from "pino";
import { buildChatSystemPrompt } from "../system-prompt";
import { createApprovalRequest, waitForApproval } from "./approval";
import { recallWorkspaceMemoryMessage } from "./assistant-recall";
import {
  assistantSystemPrompt,
  loadAssistantSteering,
} from "./assistant-steering";
import {
  openAssistantRun,
  readAssistantAgentState,
  type AssistantAgentState,
  type AssistantRunReceipt,
  type AssistantRunRecorder,
  type AssistantRunSurface,
} from "./assistant-run";
import {
  DEFAULT_GOVERNED_TURN_MAX_STEPS,
  runGovernedTurn,
  type GovernedTurnUsage,
} from "./governed-turn";
import {
  materializeTools,
  type ApprovalRequiredEvent,
} from "./materialize-tools";
import { pageContextMessage } from "./page-context";
import { createToolBelt, LOAD_TOOLS, SEARCH_TOOLS } from "./tool-belt";

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
  /** Makes the turn goal-shaped: a verifier judges each round against it. */
  goal?: AssistantGoal;
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
  /** Every write this turn parked, in park order; empty when none did. */
  parkedCards: AssistantParkedCard[];
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

/**
 * An operator switched the assistant off: an `agent` kill switch names the
 * workspace's assistant agent. The turn is refused before anything is written
 * and before the engine is asked anything. The handler answers it as
 * `forbidden` with reason `kill_switch`.
 */
export class AssistantStoppedError extends Error {
  override readonly name = "AssistantStoppedError";
  readonly code = "kill_switch" as const;
  constructor(
    readonly switchId: string,
    reason: string,
  ) {
    super(`the assistant is stopped by kill switch ${switchId}: ${reason}`);
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

  // The agent the turn runs as in the record. An operator's `agent` switch on
  // it refuses the turn here, before who pays is resolved and before anything
  // is written: a stop outranks the billing refusals below. The same agent is
  // handed to the tool belt, so a switch flipped after this read still cuts
  // the turn's tools and refuses its calls.
  const assistant = await inScope(() =>
    withTenantDb((tx) => readAssistantAgentState(tx, scope)),
  );
  if (assistant?.stoppedBy) {
    throw new AssistantStoppedError(
      assistant.stoppedBy.publicId,
      assistant.stoppedBy.reason,
    );
  }

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
  const selector = {
    ...(resolvedModel
      ? { model: resolvedModel }
      : resolvedTier
        ? { tier: resolvedTier }
        : {}),
    // Unconditional on purpose (ADR-131): a platform-funded turn can also
    // carry a key — the one Oxagen minted for this organisation — and a
    // narrowing on `fundedBy` would drop it and spend the shared key instead.
    ...(funding.modelKey ? { credential: funding.modelKey } : {}),
  };
  const turnModel = selectModel(selector);
  // The same selector, read for what the model is called rather than for the
  // client: on the organisation's own vendor key the wire id is the vendor's
  // bare spelling, and the catalog, the posture matrix and the provider
  // ceilings are all keyed by the gateway id. Asking the catalog about the
  // wire id answers "unknown model" and silently drops the effort the person
  // asked for.
  const identity = resolveModelIdentity(selector);
  const modelId = modelIdOf(turnModel);
  const effort =
    request.effort && supportsReasoning(identity.catalogId)
      ? request.effort
      : undefined;
  logger.info(
    {
      ...scope,
      requestId: ctx.requestId,
      modelId,
      provider: identity.provider,
      fundedBy: funding.fundedBy,
      ...(funding.keyHint ? { keyHint: funding.keyHint } : {}),
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
        identity,
        tier: resolvedTier,
        effort,
        assistant,
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
  identity: ModelIdentity;
  tier: "fast" | "balanced" | "precise" | null;
  effort: "low" | "medium" | "high" | undefined;
  /** The agent the turn runs as; null when the workspace has none yet. */
  assistant: AssistantAgentState | null;
  hooks: AssistantTurnHooks;
}

async function runPreparedTurn(
  p: PreparedInputs,
): Promise<AssistantTurnResult> {
  const { request, userId, funding, hooks } = p;
  const { ctx } = request;
  const turnStartedAt = new Date();
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

  // The belt is built before the run opens, and the order is deliberate. The
  // run's spec pins the tools this turn holds (`toolAllowlist` below), so the
  // set has to exist first. Opening the run first would not change the
  // listing either: the turn acts as the person who asked (ADR-053 §1), and
  // `capCtx` carries no agent run before the run opens or after it. The
  // listing's kill-switch cut keys on the caller and on the agent the turn
  // acts as (`actingAgent`, read in `prepareAssistantTurn` before the run
  // exists), not on a run (R4, macanderson/oxagen#3370 finding 9). A switched
  // tool is left out of the allowlist as well. The delegation ceiling is an
  // agent run's gate. A person's call passes the kernel's IAM check as that
  // person at invoke.
  //
  // `runIdRef` is filled in once `openAssistantRun` opens the run below.
  // Every materialized tool's `execute` closure reads it at call time, so a
  // parked approval attaches to this turn's run (finding 9).
  const runIdRef: { current: string | null } = { current: null };

  const [materialised, promptConfig, recalledMemory] = await inScope(() =>
    Promise.all([
      materializeTools(capCtx, {
        runIdRef,
        // A switch on the assistant agent reaches this turn's belt and calls
        // through it. The tools still run as the person.
        ...(p.assistant
          ? {
              actingAgent: {
                agentId: p.assistant.agentId,
                principalId: p.assistant.principalId,
              },
            }
          : {}),
        serverAllowlist:
          request.activeServerIds && request.activeServerIds.length > 0
            ? new Set(request.activeServerIds)
            : undefined,
        // `search_tools` and `load_tools` exist twice: as capability contracts
        // for the API and MCP surfaces, and as the belt's meta-tools. Both
        // claim the same model-facing alias. Execution resolves
        // `{...governed, ...meta}` so the meta-tool wins there, but
        // `modelToolsFor` layers the governed definition OVER meta for
        // anything pinned or loaded — so the model could be shown the
        // contract's schema and have the meta-tool run, with different
        // required fields and a different output shape. Inside a turn the belt
        // owns the names; the contracts stay for the surfaces outside it.
        excludeCapabilities: new Set([SEARCH_TOOLS, LOAD_TOOLS]),
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
  // Published steering and the workspace's instructions, ranked and fitted
  // to one budget by the assembler (ADR-093 §7, #4158). What does not fit is
  // cut and named in the manifest the run records below.
  const steering = await inScope(() =>
    loadAssistantSteering({ ...scope, promptConfig, requestId: ctx.requestId }),
  );

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
    provider: p.identity.provider,
  });

  // The run, before the engine. A refusal here is the turn's answer.
  const run = await openAssistantRun({
    ...scope,
    userId,
    surface: request.surface,
    instruction: request.content,
    ...(request.goal ? { goal: request.goal.statement } : {}),
    maxSteps: DEFAULT_GOVERNED_TURN_MAX_STEPS,
    // The spec's tool policy is the set this turn holds: the capabilities
    // materializeTools resolved, plus the belt's two meta-tools, which are
    // tool calls of the turn like any other and carry their own receipts.
    toolAllowlist: [
      ...new Set([
        ...Object.values(materialised.nameMap),
        SEARCH_TOOLS,
        LOAD_TOOLS,
      ]),
    ],
  });
  hooks.onRun?.({ runId: run.runPublicId });
  // Every materialized tool's `execute` closure reads this at call time
  // (finding 9, macanderson/oxagen#3370): a call parked from here on attaches
  // to the run whose Policy tab a person can actually see. The value is the
  // internal UUID — `createApprovalRequest` → `resolveRunPublicId` only
  // accepts a uuid and looks up `agent_runs.id`; a public `arun_…` id would
  // write `run_public_id = null` and disappear from `list_approvals({ runId })`.
  runIdRef.current = run.runId;

  // `openAssistantRun` has admitted the run and opened its attempt, but
  // `runGovernedTurn` does not install its sealing path until after its
  // preflight — the engine readiness probe, the provider tool-count cap, the
  // contract conversion — and every seal it does install runs on the detached
  // chain after it has already returned. So anything the preflight throws
  // lands in a window where the run exists and nothing will ever seal it,
  // leaving it open for ever against the per-run governance and lineage
  // invariant. An engine outage refuses every turn, so that is not one stray
  // row: it is the record filling with unsealed runs at exactly the moment
  // the record matters most. Seal as failed, then rethrow — the refusal is
  // still the turn's answer, and this never double-seals because
  // runGovernedTurn cannot reject after a seal.
  let turn: Awaited<ReturnType<typeof runGovernedTurn>>;
  try {
    // Before the engine, so the record states what steered the agent even
    // for a turn that then fails. A ledger that will not take this frame
    // refuses the turn here, the same as any other receipt it will not take:
    // steering the record cannot account for is what #3303 is about.
    await run.steeringManifest(steering);
    turn = await runGovernedTurn({
      telemetry: {
        ...scope,
        surface: request.surface === "chat" ? "app" : "api",
        messageId,
        // The person who asked (resolved in prepareAssistantTurn), so each
        // platform-paid debit of this turn is attributed to them.
        userId,
      },
      model: p.turnModel,
      ...(p.tier ? { tier: p.tier } : {}),
      // See the note on the selectModel call above: `modelKey`, not `fundedBy`,
      // decides which key the turn spends.
      ...(funding.modelKey ? { credential: funding.modelKey } : {}),
      governance: { ...materialised.governance, ...belt.governance },
      principal: userId,
      // The assembled steering, never the raw instructions column.
      system: assistantSystemPrompt(
        buildChatSystemPrompt({
          orgSlug: request.orgSlug,
          workspaceSlug: request.workspaceSlug,
          orgName: names.orgName,
          workspaceName: names.workspaceName,
        }),
        steering,
      ),
      history,
      contextMessages: [
        pageContextMessage(request.pageContext),
        recalledMemory,
      ],
      instruction: request.content,
      tools: belt.tools,
      modelTools: belt.modelTools,
      mutatingToolNames: materialised.mutatingToolNames,
      // The engine asks for tools by their model-safe alias; the ledger must
      // attribute each receipt to the capability the run spec authorized, or
      // the evidence cannot be joined back to the authorization it ran under.
      toolNameMap: materialised.nameMap,
      ...(p.effort ? { effort: p.effort } : {}),
      ...(budgetGuard !== undefined ? { budgetGuard } : {}),
      ...(request.goal ? { goal: request.goal } : {}),
      fundedBy: funding.fundedBy,
      ...(hooks.abortSignal ? { abortSignal: hooks.abortSignal } : {}),
      ledger: run,
    });
  } catch (err) {
    // A seal that itself fails must not replace the refusal the caller needs
    // to see; it is logged and the original error propagates.
    await run
      .seal({
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      })
      .catch((sealErr: unknown) => {
        logger.error(
          { err: sealErr, runId: run.runPublicId },
          "assistant run could not be sealed after a turn preflight refusal",
        );
      });
    throw err;
  }

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

  // The execution's id reaches readers through the assistant message's
  // `metadata.executionId`, which the handler writes under
  // `updateMessageMetadata` — the same place the old route left it.
  await recordTurnExecution({
    run,
    capCtx,
    assistantMessageId,
    instruction: request.content,
    conversationId,
    reply,
    usage,
    startedAt: turnStartedAt,
  });

  return {
    conversationId,
    userMessageId,
    assistantMessageId,
    runId: run.runPublicId,
    reply,
    parkedCards: parked,
  };
}

/**
 * The turn's agent-execution record (SOC 2 CC6/CC7) and the Neo4j tool-usage
 * lineage projection that rides with it.
 *
 * The evidence ledger is the authority on what the turn did — every reverse
 * request has a receipt there, and the seal attests to them. `agent_executions`
 * is a different question answered for a different reader: `list_executions`
 * and `get_execution_trace` read it, and both stay on the agent surface, one
 * `load_tools` call away from the assistant. `list_runs` excludes the
 * assistant's own turns, so these two are how it reads back what it did.
 * `projectToolUsageBestEffort` (the handler's own tail) is the only writer of
 * the lineage projection. A turn that skips this leaves both answering
 * "nothing happened", which is worse than answering nothing at all.
 *
 * Best effort by construction, and deliberately so: the reply is already
 * persisted and, on the SSE route, already sent. A failure here is a gap in
 * the audit trail, which is a defect — so it is logged loudly with the ids
 * needed to find it, never swallowed, and never allowed to fail the turn the
 * person already has an answer to.
 */
async function recordTurnExecution(args: {
  run: AssistantRunRecorder;
  capCtx: CapabilityContext;
  assistantMessageId: string;
  instruction: string;
  conversationId: string;
  reply: string;
  usage: { inputTokens: number; outputTokens: number };
  startedAt: Date;
}): Promise<void> {
  const { run, capCtx, assistantMessageId } = args;
  const completedAt = new Date();
  try {
    await invoke(
      chatMessageExecution.name,
      {
        messageId: assistantMessageId,
        agentId: run.agentId,
        agentVersionId: run.agentVersionId,
        originType: "chat" as const,
        originId: assistantMessageId,
        status: "completed" as const,
        inputPayload: {
          content: args.instruction,
          conversationId: args.conversationId,
        },
        // The ledger holds the turn's text; this record holds the shape of it.
        outputPayload: { text: args.reply.length > 0 ? "[streamed]" : null },
        startedAt: args.startedAt,
        completedAt,
        latencyMs: Math.max(
          0,
          completedAt.getTime() - args.startedAt.getTime(),
        ),
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        updateMessageMetadata: true,
        steps: stepsFromReceipts(run.receipts),
      },
      { ...capCtx, messageId: assistantMessageId },
      { surface: "api" },
    );
  } catch (err) {
    logger.error(
      {
        err,
        messageId: assistantMessageId,
        runId: run.runPublicId,
        orgId: capCtx.orgId,
        workspaceId: capCtx.workspaceId,
      },
      "assistant turn: agent-execution record failed; the SOC 2 audit trail and the lineage projection have a gap for this turn",
    );
  }
}

/**
 * The ledger's receipts as execution steps. One step per model completion,
 * numbered from 1 in engine-frame order; the tool calls the engine asked for
 * after a completion hang off that completion's step, which is the shape
 * `get_execution_trace` renders. Tool calls that arrive before any completion
 * (there are none today, but the engine decides the order, not this code) get
 * a step of their own rather than being dropped.
 */
function stepsFromReceipts(
  receipts: readonly AssistantRunReceipt[],
): ChatMessageExecutionStep[] {
  const steps: ChatMessageExecutionStep[] = [];
  const openStep = (inputPayload: unknown): ChatMessageExecutionStep => {
    const step: ChatMessageExecutionStep = {
      stepNumber: steps.length + 1,
      stepType: "llm_turn",
      status: "completed",
      inputPayload,
      toolCalls: [],
    };
    steps.push(step);
    return step;
  };
  for (const receipt of receipts) {
    if (receipt.kind === "model") {
      const step = openStep({
        provider: receipt.provider,
        model: receipt.model,
        role: receipt.role,
        engineSeq: receipt.seq,
      });
      step.status = receipt.outcome === "completed" ? "completed" : "failed";
      if (receipt.usage) {
        step.inputTokens = receipt.usage.input_tokens;
        step.outputTokens = receipt.usage.output_tokens;
      }
      continue;
    }
    const step =
      steps[steps.length - 1] ?? openStep({ engineSeq: receipt.seq });
    step.toolCalls?.push({
      toolName: receipt.toolName,
      toolType: "capability",
      requestPayload: receipt.input,
      ...(receipt.outcome === "completed"
        ? { responsePayload: receipt.output }
        : { responsePayload: { error: receipt.error ?? receipt.outcome } }),
      status: receipt.outcome === "completed" ? "completed" : "failed",
      latencyMs: Math.max(0, Math.round(receipt.durationMs)),
    });
  }
  return steps;
}

type ChatMessageExecutionStep = NonNullable<
  ChatMessageExecutionInput["steps"]
>[number];

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
        createdById: userId,
        updatedById: userId,
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
      createdById: userId,
      updatedById: userId,
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
      createdById: userId,
      updatedById: userId,
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
