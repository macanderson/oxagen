// Stateful translator for the REST chat SSE stream. It consumes raw AI-SDK
// `fullStream` parts one at a time and emits the exact `ApiStreamEvent` wire
// shapes the chat.stream route has always emitted.
//
// It is the SINGLE source of truth for the part→SSE mapping: one part in, the
// SSE events for it out. It knows nothing about who is feeding it — it takes
// generic AI-SDK parts (text, reasoning, step boundaries, tool calls/results,
// usage, error) and no others. The turn behind the parts is
// `prepareAssistantTurn` (@oxagen/agent); the turn's own result carries the
// reply and the usage, so this translator keeps no copy of either.

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
  | { type: "run"; runId: string }
  | { type: "error"; message: string; code?: string };

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
  /** Feed one raw AI-SDK `fullStream` part; emits its SSE events. */
  onPart(raw: unknown): void;
}

/**
 * Build a stateful translator that maps raw AI-SDK parts onto the chat.stream
 * SSE `ApiStreamEvent` shapes.
 *
 * The translator does NOT emit a `usage` event. The route emits ONE aggregated
 * `usage` after the turn ends, from the turn's own summed totals — the same
 * single event, in the same position (last event before the terminal), that
 * this surface has always emitted.
 */
export function createApiStreamTranslator(args: {
  toolNameMap: Record<string, string>;
  emit: (event: ApiStreamEvent) => void;
}): ApiStreamTranslator {
  const { toolNameMap, emit } = args;

  const toolStartedAt: Record<string, number> = {};
  const reasoningStartedAt: Record<string, number> = {};
  let stepIndex = -1;

  const onPart = (raw: unknown): void => {
    const pType = partType(raw);
    if (pType === "text-delta") {
      const text = (raw as { text: string }).text;
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
      emit({ type: "step-start", stepIndex });
    } else if (pType === "finish-step") {
      if (stepIndex >= 0) emit({ type: "step-finish", stepIndex });
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
      emit({
        type: "tool-call-end",
        toolCallId,
        status: "failed",
        errorReason: errorMessageOf(error),
        durationMs,
      });
    } else if (pType === "finish") {
      // No usage here: the route emits ONE aggregated usage from the turn's
      // own totals after the turn ends.
    } else if (pType === "error") {
      // No error event here, for the same reason `finish` emits no usage: the
      // route owns the one terminal `error` SSE event and emits it from the
      // turn's rejection, where the failure still carries its code. A turn
      // that produces an error part always goes on to reject with that same
      // failure, so emitting here too sent the client two error events for
      // one failure — an untyped one now and the coded one moments later.
      // Logged here because this is where the part is seen.
      const errVal = (raw as { error?: unknown }).error;
      const message =
        errVal instanceof Error
          ? errVal.message
          : typeof errVal === "string"
            ? errVal
            : "Stream error";
      console.error("[chat.stream] LLM stream error part:", message);
    }
  };

  return { onPart };
}
