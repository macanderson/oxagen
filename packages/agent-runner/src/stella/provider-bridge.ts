/**
 * The model half of the port mapping: one `provider_request` frame becomes one
 * call through the host's existing `AgentAi` port.
 *
 * The engine holds no ambient authority — it never calls a model — so every
 * step it wants re-enters oxagen here, through the same `AgentAi` the TS loop
 * uses. On the platform that is `streamAgentReply`: IAM, entitlement, billing
 * admission, gateway routing, BYOK credentials and the `token_usage` write all
 * happen exactly where they happen today. **Metering does not move**
 * (adoption plan §3): the host makes the call, so the host meters it, and
 * Stella's own `StepUsage` frames are a cross-check rather than a second
 * source of truth.
 *
 * ## One call, never a loop
 *
 * `stopWhen: stepCountIs(1)` and an execute-free tool set
 * ({@link toModelToolSet}) together make this a single completion: the SDK
 * returns the model's tool calls rather than running them, and Stella decides
 * what happens next. If either were missing the SDK would run its own agentic
 * loop inside a single reverse request, and the two engines would be driving
 * the same turn at once.
 */
import { stepCountIs, type ModelMessage, type ToolSet } from "ai";
import type { AgentAi } from "@oxagen/agent-engine";
import type {
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  FinishReason,
  ProviderHandler,
  ToolCall as StellaToolCall,
} from "@oxagen/stella-engine-client";
import { toModelMessages } from "./message-mapping";

/**
 * Prices one completion, in USD.
 *
 * Injected rather than imported: `@oxagen/agent-runner` stays dependency-light
 * and the engine has never priced tokens (see `RunCodingAgentOptions.budgetGuard`,
 * which makes the same split for the same reason). The platform passes an
 * `@oxagen/billing`-backed implementation.
 */
export type CompletionPricer = (args: {
  usage: CompletionUsage;
  model: string;
}) => number;

export interface ProviderBridgeOptions {
  ai: AgentAi;
  /** Model slug for this turn; the engine does not choose it — the host does. */
  model: string;
  /** System prompt, hoisted out of the transcript (see {@link createProviderHandler}). */
  system: string;
  /** Advertised tool schemas, already stripped of `execute`. */
  tools: ToolSet;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  signal?: AbortSignal;
  /** Raw AI-SDK stream tap, forwarded verbatim exactly as the TS loop does. */
  onStreamPart?: (part: unknown) => void;
  /**
   * Prices the call for `CompletionResult.cost_usd`. Omitted ⇒ every call is
   * reported to the engine as costing zero, which is why
   * {@link runStellaTurn} refuses to arm an *enforced* Stella-side budget
   * without one: a ceiling that can never be reached is not a ceiling. The
   * host's own metering is unaffected either way.
   */
  price?: CompletionPricer;
  /** Called with each completion's usage, so the turn can total it host-side. */
  onUsage?: (usage: CompletionUsage, model: string) => void;
}

/**
 * Build the handler that answers every `provider_request` for one turn.
 *
 * The system prompt is hoisted rather than left in `messages` because
 * `ModelRunArgs.system` is a required, separate field on the `AgentAi` port —
 * the adapters below it pass it to the provider as a system parameter, not as
 * a message. Stella carries it as the transcript's leading `system` message,
 * so the two spellings are reconciled here and nowhere else.
 */
export function createProviderHandler(
  options: ProviderBridgeOptions,
): ProviderHandler {
  return async (request: CompletionRequest): Promise<CompletionResult> => {
    const { system, messages } = splitSystem(
      toModelMessages(request.messages),
      options.system,
    );

    const stream = options.ai.stream({
      model: options.model,
      system,
      messages,
      tools: options.tools,
      // See the module doc: exactly one completion per reverse request.
      stopWhen: stepCountIs(1),
      abortSignal: options.signal,
      effort: options.effort ?? request.effort,
    });

    // Draining `fullStream` is what drives the completion, and it is also the
    // only place the raw parts exist. The TS loop taps them in the same place
    // and for the same consumer (the in-app SSE translator), so a surface sees
    // the identical part sequence whichever engine ran the turn.
    if (options.onStreamPart) {
      for await (const part of stream.fullStream) options.onStreamPart(part);
    }

    const [text, toolCalls, usage, finishReason] = await Promise.all([
      stream.text,
      stream.toolCalls,
      stream.usage,
      stream.finishReason,
    ]);

    const completionUsage = toCompletionUsage(usage);
    options.onUsage?.(completionUsage, options.model);

    return {
      text,
      ...(toolCalls.length > 0
        ? { tool_calls: toolCalls.map(toStellaToolCall) }
        : {}),
      usage: completionUsage,
      model: options.model,
      cost_usd:
        options.price?.({ usage: completionUsage, model: options.model }) ?? 0,
      finish_reason: toStellaFinishReason(finishReason),
    };
  };
}

/**
 * Pull leading `system` messages out of the transcript into the port's own
 * `system` field, falling back to the turn's prompt when the engine sent none.
 */
export function splitSystem(
  messages: readonly ModelMessage[],
  fallback: string,
): { system: string; messages: ModelMessage[] } {
  const leading: string[] = [];
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    leading.push(String(messages[index]!.content));
    index += 1;
  }
  return {
    system: leading.length > 0 ? leading.join("\n\n") : fallback,
    // Any LATER system message stays in place: it is a mid-conversation
    // steering message, not the turn's prefix, and hoisting it would move it
    // ahead of the messages it was meant to follow.
    messages: messages.slice(index),
  };
}

function toStellaToolCall(call: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}): StellaToolCall {
  return {
    call_id: call.toolCallId,
    name: call.toolName,
    input: (call.input ?? {}) as Record<string, unknown>,
  };
}

/**
 * `LanguageModelUsage` → Stella's `CompletionUsage`.
 *
 * `reported: true` because these numbers come from the provider through the
 * host's adapter rather than from an estimate. `cached_input_tokens` is a
 * SUBSET of `input_tokens`, not additional to it — the same contract
 * `UsageTokens.cachedInputTokens` documents on the TS side.
 */
export function toCompletionUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
}): CompletionUsage {
  const cached = usage.inputTokenDetails?.cacheReadTokens;
  return {
    reported: true,
    input_tokens: usage.inputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    ...(cached !== undefined ? { cached_input_tokens: cached } : {}),
  };
}

/**
 * The AI SDK's finish reason → Stella's.
 *
 * `tool_calls`, never `tool_use`: the latter is Anthropic's spelling and the
 * server rejects it with a 400 naming the valid variants. `error` and `other`
 * have no Stella spelling and map to `stop` — the completion did end, and the
 * engine decides what to do about a step that produced nothing.
 */
export function toStellaFinishReason(reason: string): FinishReason {
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
