/**
 * Engine events as the stream parts the chat surfaces already read.
 *
 * Both chat routes consume a turn as AI-SDK-shaped parts and translate them
 * to their own wire formats, and the API's format is pinned byte for byte by
 * a snapshot test. So the engine's events are mapped onto that vocabulary
 * here, and nothing downstream learns which loop ran the turn.
 *
 * The mapping is stateful for one reason: the engine's `tool_result` carries
 * a `call_id`, an output and a duration, and no tool name or input, both of
 * which live on the `tool_start` before it. A per-turn table joins them. The
 * same table carries the host-side value each tool returned, because the
 * app paints render directives out of a tool's structured result and the
 * engine only ever saw its text.
 */
import type { AgentEvent, TurnOutcomeWire } from "@oxagen/stella-engine-client";

/** The AI-SDK part vocabulary the translators switch on. */
export type EnginePart =
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "text-delta"; id: string; text: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: "tool-error";
      toolCallId: string;
      toolName: string;
      input: unknown;
      error: unknown;
    }
  | {
      type: "finish";
      finishReason: string;
      totalUsage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
      };
    }
  | { type: "error"; error: unknown };

export interface PartMapperUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
}

export interface PartMapper {
  /** Map one engine event; returns the parts it becomes, often none. */
  map(event: AgentEvent): EnginePart[];
  /**
   * The terminal frame's outcome as the parts that end the stream. `usage` is
   * the host's own total, which the chokepoint metered; the engine's
   * `step_usage` sum is kept beside it as a cross-check.
   */
  finish(outcome: TurnOutcomeWire, usage?: PartMapperUsage): EnginePart[];
  /**
   * Record what the host's tool actually returned. A `tool_request` carries
   * the tool's name and input but not the model's call id, which only the
   * later `tool_start` and `tool_result` events name, so returns are queued
   * by name and input and joined to the result in order.
   */
  recordToolReturn(
    name: string,
    input: unknown,
    raw: unknown,
    failed: boolean,
    error?: unknown,
  ): void;
  /** Usage summed from the engine's `step_usage` events so far. */
  readonly usage: PartMapperUsage;
  /** The authoritative answer text, from the engine's `text` event. */
  readonly text: string;
}

export function createPartMapper(): PartMapper {
  const calls = new Map<string, { name: string; input: unknown }>();
  const returns = new Map<
    string,
    Array<{ raw: unknown; failed: boolean; error?: unknown }>
  >();
  const returnKey = (name: string, input: unknown): string => {
    let rendered: string;
    try {
      rendered = JSON.stringify(input) ?? "";
    } catch {
      rendered = String(input);
    }
    return `${name}\u0000${rendered}`;
  };
  const usage: PartMapperUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
  };
  let text = "";
  let step = 0;
  let stepOpen = false;
  let reasoningOpen: string | undefined;
  let delta = 0;

  const openStep = (): EnginePart[] => {
    if (stepOpen) return [];
    stepOpen = true;
    step += 1;
    return [{ type: "start-step" }];
  };
  const closeReasoning = (): EnginePart[] => {
    if (reasoningOpen === undefined) return [];
    const id = reasoningOpen;
    reasoningOpen = undefined;
    return [{ type: "reasoning-end", id }];
  };
  const closeStep = (): EnginePart[] => {
    if (!stepOpen) return [];
    stepOpen = false;
    return [...closeReasoning(), { type: "finish-step" }];
  };

  return {
    get usage() {
      return usage;
    },
    get text() {
      return text;
    },
    recordToolReturn(name, input, raw, failed, error) {
      const key = returnKey(name, input);
      const queue = returns.get(key) ?? [];
      queue.push({ raw, failed, error });
      returns.set(key, queue);
    },
    map(event) {
      switch (event.type) {
        case "step_manifest":
          // Describes the call that just ran; the boundary is `step_usage`.
          return [];
        case "text_delta": {
          delta += 1;
          return [
            ...openStep(),
            ...closeReasoning(),
            { type: "text-delta", id: `t${step}`, text: event.delta },
          ];
        }
        case "reasoning": {
          const parts = openStep();
          if (reasoningOpen === undefined) {
            reasoningOpen = `r${step}-${delta}`;
            parts.push({ type: "reasoning-start", id: reasoningOpen });
          }
          parts.push({
            type: "reasoning-delta",
            id: reasoningOpen,
            text: event.delta,
          });
          return parts;
        }
        case "text":
          // The authoritative answer; the deltas were the preview.
          text = event.text;
          return [];
        case "tool_start": {
          const call = event.call;
          calls.set(call.call_id, { name: call.name, input: call.input });
          return [
            ...openStep(),
            {
              type: "tool-call",
              toolCallId: call.call_id,
              toolName: call.name,
              input: call.input,
            },
          ];
        }
        case "tool_result": {
          const started = calls.get(event.call_id);
          const name = started?.name ?? "";
          const input = started?.input;
          const returned = started
            ? returns.get(returnKey(started.name, started.input))?.shift()
            : undefined;
          const failed = returned ? returned.failed : "error" in event.output;
          if (failed) {
            const error =
              returned?.error ??
              new Error(
                "error" in event.output
                  ? event.output.error.message
                  : "tool failed",
              );
            return [
              {
                type: "tool-error",
                toolCallId: event.call_id,
                toolName: name,
                input,
                error,
              },
            ];
          }
          // The host's own return value, when it ran the tool; the engine's
          // text otherwise (a speculated or replayed result).
          const output = returned
            ? returned.raw
            : "ok" in event.output
              ? event.output.ok.content
              : "";
          return [
            {
              type: "tool-result",
              toolCallId: event.call_id,
              toolName: name,
              input,
              output,
            },
          ];
        }
        case "step_usage": {
          usage.inputTokens += event.input_tokens;
          usage.outputTokens += event.output_tokens;
          usage.totalTokens += event.input_tokens + event.output_tokens;
          usage.cachedInputTokens += event.cached_input_tokens ?? 0;
          return closeStep();
        }
        case "error":
          return [{ type: "error", error: new Error(event.message) }];
        default:
          return [];
      }
    },
    finish(outcome, hostUsage) {
      const parts = closeStep();
      const totalUsage = { ...(hostUsage ?? usage) };
      if (outcome.status === "completed") {
        if (!text) text = outcome.text;
        parts.push({ type: "finish", finishReason: "stop", totalUsage });
      } else {
        parts.push({
          type: "error",
          error: Object.assign(new Error(outcome.reason), {
            code: "engine_aborted",
          }),
        });
        parts.push({ type: "finish", finishReason: "error", totalUsage });
      }
      return parts;
    },
  };
}
