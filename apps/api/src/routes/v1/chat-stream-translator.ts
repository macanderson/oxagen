// Stateful translator for the REST chat SSE stream. It consumes raw AI-SDK
// `fullStream` parts one at a time and emits the exact `ApiStreamEvent` wire
// shapes the chat.stream route has always emitted, while collecting per-step
// execution metadata for the SOC 2 audit trail.
//
// It is the SINGLE source of truth for the part→SSE mapping. The route drives it
// via `runCodingAgent`'s `onStreamPart` tap (one part at a time, across the
// engine's per-step `streamText` calls) instead of a hand-rolled `for await`
// over a single `streamAgentReply` — so the multi-step tool loop (`stopWhen`),
// invoke()-gated tools, per-turn memory recall, and the USD budget guard all
// apply, with the client wire protocol byte-identical to before the engine
// unification.

// Minimal typed stream events emitted over SSE. UNCHANGED wire shapes — every
// field name and event `type` matches the pre-engine chat.stream output. The
// `budget-notice` variant is additive: it fires ONLY when a per-turn USD budget
// policy is active (off by default), so a budget-less turn's byte output is
// unchanged.
export type ApiStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning-start"; reasoningId: string }
  | { type: "reasoning-delta"; reasoningId: string; text: string }
  | { type: "reasoning-end"; reasoningId: string; durationMs: number }
  | { type: "step-start"; stepIndex: number }
  | { type: "step-finish"; stepIndex: number }
  | { type: "tool-input-start"; toolCallId: string; capability: string }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
  | {
      type: "tool-call-start";
      toolCallId: string;
      capability: string;
      inputPreview: unknown;
      riskLevel: string;
    }
  | {
      type: "tool-call-end";
      toolCallId: string;
      status: "completed" | "failed";
      output?: unknown;
      errorReason?: string;
      durationMs: number;
    }
  | {
      type: "approval-required";
      approvalId: string;
      capability: string;
      inputPreview: unknown;
      riskLevel: string;
      expiresAt: string;
    }
  | {
      type: "usage";
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
    }
  | {
      type: "budget-notice";
      state: "within_grace" | "stopped";
      costUsd: number;
      limitUsd: number;
      mode: string;
    }
  | { type: "error"; message: string };

// Collected token + step data returned by the translator for execution recording.
export type CollectedExecutionToolCall = {
  toolCallId: string;
  toolName: string;
  inputPreview: unknown;
  output?: unknown;
  status: "completed" | "failed";
  durationMs: number;
};

export type CollectedExecutionStep = {
  stepNumber: number;
  stepType: string;
  status: "completed";
  inputPayload: unknown;
  toolCalls: CollectedExecutionToolCall[];
  latencyMs: number;
};

export type CollectedExecution = {
  inputTokens: number;
  outputTokens: number;
  steps: CollectedExecutionStep[];
};

export type TranslatedTurn = {
  assistantText: string;
  execution: CollectedExecution;
  // True when the model surfaced an `error` part mid-stream. With the engine a
  // provider/stream error THROWS to the route's catch instead, so this is a
  // defensive backstop; the accumulated assistantText is then partial and must
  // not be persisted as a successful turn.
  streamErrored: boolean;
};

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

export interface ApiStreamTranslator {
  /** Feed one raw AI-SDK `fullStream` part; emits SSE events + collects execution. */
  onPart(raw: unknown): void;
  /** Finalize and return accumulated text + execution metadata. */
  finish(): TranslatedTurn;
}

/**
 * Build a stateful translator that maps raw AI-SDK parts onto the chat.stream
 * SSE `ApiStreamEvent` shapes and accumulates per-step execution metadata.
 *
 * Note on `finish`: the translator collects the per-step token totals but does
 * NOT emit a `usage` event. With the engine's per-step loop each step yields its
 * own `finish` part; emitting per step would send multiple growing usage events.
 * The route emits ONE aggregated `usage` after the loop from the engine's summed
 * `result.usage` — the same single event, in the same position (last event
 * before `[DONE]`), that the single-step stream always emitted.
 */
export function createApiStreamTranslator(args: {
  toolNameMap: Record<string, string>;
  emit: (event: ApiStreamEvent) => void;
}): ApiStreamTranslator {
  const { toolNameMap, emit } = args;

  let assistantText = "";
  let streamErrored = false;
  const toolStartedAt: Record<string, number> = {};
  const reasoningStartedAt: Record<string, number> = {};
  let stepIndex = -1;

  // Execution collection state.
  const collectedSteps: CollectedExecutionStep[] = [];
  const stepStartedAt: Record<number, number> = {};
  const toolCallToStep: Record<string, number> = {};
  const collectedToolCalls: Record<string, CollectedExecutionToolCall> = {};
  let collectedInputTokens = 0;
  let collectedOutputTokens = 0;

  const onPart = (raw: unknown): void => {
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
      const durationMs =
        reasoningStartedAt[id] !== undefined
          ? Date.now() - (reasoningStartedAt[id] as number)
          : 0;
      emit({ type: "reasoning-end", reasoningId: id, durationMs });
    } else if (pType === "start-step") {
      stepIndex += 1;
      stepStartedAt[stepIndex] = Date.now();
      emit({ type: "step-start", stepIndex });
    } else if (pType === "finish-step") {
      if (stepIndex >= 0) {
        const latencyMs =
          stepStartedAt[stepIndex] !== undefined
            ? Date.now() - (stepStartedAt[stepIndex] as number)
            : 0;
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
      const { toolCallId, toolName, input } = raw as {
        toolCallId: string;
        toolName: string;
        input: unknown;
      };
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
      const { toolCallId, output } = raw as {
        toolCallId: string;
        output: unknown;
      };
      const durationMs =
        toolStartedAt[toolCallId] !== undefined
          ? Date.now() - (toolStartedAt[toolCallId] as number)
          : 0;
      if (collectedToolCalls[toolCallId]) {
        collectedToolCalls[toolCallId] = {
          ...(collectedToolCalls[toolCallId] as CollectedExecutionToolCall),
          output,
          status: "completed",
          durationMs,
        };
      }
      emit({
        type: "tool-call-end",
        toolCallId,
        status: "completed",
        output,
        durationMs,
      });
    } else if (pType === "tool-error") {
      const { toolCallId, error } = raw as {
        toolCallId: string;
        error: unknown;
      };
      const durationMs =
        toolStartedAt[toolCallId] !== undefined
          ? Date.now() - (toolStartedAt[toolCallId] as number)
          : 0;
      if (collectedToolCalls[toolCallId]) {
        collectedToolCalls[toolCallId] = {
          ...(collectedToolCalls[toolCallId] as CollectedExecutionToolCall),
          status: "failed",
          durationMs,
        };
      }
      emit({
        type: "tool-call-end",
        toolCallId,
        status: "failed",
        errorReason: errorMessageOf(error),
        durationMs,
      });
    } else if (pType === "finish") {
      // Collect per-step token totals; do NOT emit usage here (see the factory
      // doc comment). The route emits ONE aggregated usage after the loop from
      // the engine's summed result.usage. With the engine's per-step loop this
      // arm fires once per step — the LAST step carries the turn totals.
      const { totalUsage } = raw as {
        totalUsage?: {
          inputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
        };
      };
      if (totalUsage) {
        collectedInputTokens = totalUsage.inputTokens ?? collectedInputTokens;
        collectedOutputTokens =
          totalUsage.outputTokens ?? collectedOutputTokens;
      }
    } else if (pType === "error") {
      // Defensive backstop: the engine THROWS provider/stream errors to the
      // route's catch rather than yielding an `error` part, but if one ever
      // arrives here, surface it as a typed `error` SSE event and mark the turn
      // errored so the route skips persisting a partial reply.
      const errVal = (raw as { error?: unknown }).error;
      const message =
        errVal instanceof Error
          ? errVal.message
          : typeof errVal === "string"
            ? errVal
            : "Stream error";
      streamErrored = true;
      console.error("[chat.stream] LLM stream error part:", message);
      emit({ type: "error", message });
    }
  };

  const finish = (): TranslatedTurn => ({
    assistantText,
    streamErrored,
    execution: {
      inputTokens: collectedInputTokens,
      outputTokens: collectedOutputTokens,
      steps: collectedSteps,
    },
  });

  return { onPart, finish };
}
