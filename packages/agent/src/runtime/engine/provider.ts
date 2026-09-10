/**
 * The model half of the engine port: one `provider_request` frame becomes one
 * call through `streamAgentReply`, the only permitted LLM chokepoint.
 *
 * The engine holds no key and calls no vendor, so every completion it wants
 * re-enters Oxagen here. That is where the funding source resolves the key
 * (ADR-053 §2), where the tokens are written to `token_usage`, and where a
 * platform-paid call is charged as assistant usage (ADR-053 §3). Metering does
 * not move: the host makes the call, so the host meters it, and the engine's
 * own `step_usage` events are a cross-check.
 *
 * One call, never a loop. `stopWhen: stepCountIs(1)` and an execute-free tool
 * set together make this a single completion: the SDK returns the model's
 * tool calls rather than running them, and the engine decides what happens
 * next. Without either the SDK would run its own agentic loop inside one
 * reverse request, and two engines would drive one turn.
 *
 * The role on the request picks the model. The worker gets the turn's model.
 * A verdict, the engine's judge of whether a goal was met, gets a model that
 * is not the worker's, because a judge that shares the worker's weights is
 * not independent. Summarisation gets the fast tier, because it is paid for
 * on every long turn and its output is read by a model, not a person.
 */
import {
  modelIdOf,
  selectModel,
  stepCountIs,
  streamAgentReply,
  type EffortLevel,
  type ModelCredential,
  type OxagenTier,
  type StreamAgentReplyArgs,
  type ToolSet,
  type TurnFunding,
} from "@oxagen/ai";
import { CREDIT_REASONS, providerCostUsdMicros } from "@oxagen/billing";
import type {
  CompletionResult,
  CompletionUsage,
  FinishReason,
  ModelCallRoleWire,
  ProviderRequestContext,
  ProviderRequestView,
  ToolCall,
} from "@oxagen/stella-engine-client";
import { runInTenantScope } from "@oxagen/tenancy";
import { toModelMessages } from "./messages";

export interface ProviderPortOptions {
  /** The turn's model: what the worker role runs on. */
  model: NonNullable<StreamAgentReplyArgs["model"]>;
  /** Which tier the worker is on, so the other roles can pick a different one. */
  workerTier: OxagenTier;
  /** The customer's key when the organisation brought one. */
  credential?: ModelCredential;
  /** The system prompt, hoisted out of the transcript (see `splitSystem`). */
  system: string;
  /** Advertised tools, already stripped of `execute`. */
  tools: ToolSet;
  telemetry: StreamAgentReplyArgs["telemetry"];
  fundedBy: TurnFunding;
  effort?: EffortLevel | null;
  /** Called with each completion's usage so the turn can total it host-side. */
  onUsage?: (usage: CompletionUsage, model: string) => void;
}

/** A completion answered for a role, with the model that served it. */
export interface RoleModel {
  model: NonNullable<StreamAgentReplyArgs["model"]>;
  modelId: string;
}

/**
 * The model for a role. Exported so the choice is testable on its own: a
 * verdict on the same model as the worker is the one outcome this function
 * exists to prevent.
 */
export function modelForRole(
  role: ModelCallRoleWire,
  options: Pick<ProviderPortOptions, "model" | "workerTier" | "credential">,
): RoleModel {
  const pick = (tier: OxagenTier): RoleModel => {
    const model = selectModel({
      tier,
      ...(options.credential ? { credential: options.credential } : {}),
    });
    return { model, modelId: modelIdOf(model) };
  };
  switch (role) {
    case "verdict":
    case "judge":
      return pick(options.workerTier === "precise" ? "balanced" : "precise");
    case "summarization":
    case "reflection":
    case "domain_inference":
      return pick("fast");
    default:
      return { model: options.model, modelId: modelIdOf(options.model) };
  }
}

/** Build the handler that answers every `provider_request` of one turn. */
export function createProviderPort(options: ProviderPortOptions) {
  return async (
    request: ProviderRequestView,
    context: ProviderRequestContext,
  ): Promise<CompletionResult> => {
    const { system, messages } = splitSystem(
      toModelMessages(request.request.messages),
      options.system,
    );
    const { model, modelId } = modelForRole(request.role, options);
    const effort = options.effort ?? request.request.effort ?? undefined;

    // The tenant scope is what lets the chokepoint's onFinish charge credits
    // and write telemetry; a reverse request arrives on the engine's clock,
    // outside any request scope.
    const stream = await runInTenantScope(
      {
        orgId: options.telemetry.orgId,
        workspaceId: options.telemetry.workspaceId,
      },
      async () =>
        streamAgentReply({
          messages,
          system,
          tools: options.tools,
          model,
          telemetry: options.telemetry,
          fundedBy: options.fundedBy,
          // Always the assistant reason: this port is the in-app agent, and
          // ADR-053 §3 gives its platform-paid tokens their own ledger line.
          chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
          stopWhen: stepCountIs(1),
          abortSignal: context.signal,
          ...(effort ? { effort } : {}),
          ...(typeof request.request.max_output_tokens === "number"
            ? { maxOutputTokens: request.request.max_output_tokens }
            : {}),
        }),
    );

    // Draining fullStream is what drives the completion. Text and reasoning
    // fragments go back to the engine as they arrive, so the chat surface
    // renders tokens live and the engine's idle deadline is reset; the
    // result below is the text of record.
    let pending: Array<{ kind: "text" | "reasoning"; text: string }> = [];
    let flush: Promise<void> = Promise.resolve();
    const push = (kind: "text" | "reasoning", text: string): void => {
      if (text.length === 0) return;
      pending.push({ kind, text });
      if (pending.length >= 8) drain();
    };
    const drain = (): void => {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      flush = flush.then(() => context.deltas(batch)).catch(() => undefined);
    };
    for await (const part of stream.fullStream) {
      const p = part as { type?: string; text?: string };
      if (p.type === "text-delta" && typeof p.text === "string")
        push("text", p.text);
      else if (p.type === "reasoning-delta" && typeof p.text === "string")
        push("reasoning", p.text);
    }
    drain();
    await flush;

    const [text, toolCalls, usage, finishReason] = await Promise.all([
      stream.text,
      stream.toolCalls,
      stream.usage,
      stream.finishReason,
    ]);
    const completionUsage = toCompletionUsage(usage);
    options.onUsage?.(completionUsage, modelId);

    return {
      text,
      tool_calls: toolCalls.map(toEngineToolCall),
      usage: completionUsage,
      model: modelId,
      cost_usd:
        providerCostUsdMicros({
          model: modelId,
          inputTokens: completionUsage.input_tokens,
          outputTokens: completionUsage.output_tokens,
          cachedTokens: completionUsage.cached_input_tokens ?? 0,
          cacheWriteTokens: completionUsage.cache_write_tokens ?? 0,
        }) / 1_000_000,
      finish_reason: toEngineFinishReason(finishReason),
    };
  };
}

/**
 * Pull leading `system` messages out of the transcript into the chokepoint's
 * own `system` field, falling back to the turn's prompt when the engine sent
 * none. A later system message stays in place: it is mid-conversation
 * steering, not the prefix, and hoisting it would move it ahead of the
 * messages it was meant to follow.
 */
export function splitSystem(
  messages: readonly StreamAgentReplyArgs["messages"][number][],
  fallback: string,
): { system: string; messages: StreamAgentReplyArgs["messages"] } {
  const leading: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    leading.push(String(messages[index]!.content));
    index += 1;
  }
  return {
    system: leading.length > 0 ? leading.join("\n\n") : fallback,
    messages: messages.slice(index),
  };
}

function toEngineToolCall(call: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): ToolCall {
  return {
    call_id: call.toolCallId,
    name: call.toolName,
    input: call.input ?? {},
  };
}

/**
 * The SDK's usage as the engine's. `reported: true` because the numbers come
 * from the provider through the chokepoint, not from an estimate. Cache reads
 * are a subset of `input_tokens`; cache writes are not.
 */
export function toCompletionUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}): CompletionUsage {
  return {
    reported: true,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    cached_input_tokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/**
 * The SDK's finish reason as the engine's. `tool_calls`, never `tool_use`:
 * the latter is one vendor's spelling and the engine refuses it. `error` and
 * `other` have no engine spelling and map to `stop`; the completion did end,
 * and the engine decides what to do about a step that produced nothing.
 */
export function toEngineFinishReason(reason: string): FinishReason {
  switch (reason) {
    case "tool-calls":
      return "tool_calls";
    case "length":
      return "length";
    case "content-filter":
      return "content_filter";
    default:
      return "stop";
  }
}
