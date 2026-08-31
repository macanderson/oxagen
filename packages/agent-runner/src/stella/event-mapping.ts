/**
 * Stella `AgentEvent` frames → oxagen `CodingEvent`s.
 *
 * This is Phase C item 4 ("map Stella `AgentEvent` frames onto the
 * `agent_run_events` vocabulary"), and it is deliberately smaller than that
 * sentence suggests. The durable-run driver already funnels the engine's
 * events into `agent_run_events` through one callback —
 * `turn-driver.ts`'s `onEvent: (e) => io.onEvent("coding-event", e)`. So a
 * Stella event that arrives as a `CodingEvent` lands in the event log by the
 * path that already exists, in the vocabulary every reader already speaks.
 * Nothing in `run-store.ts`, the worker, or any surface changes.
 *
 * ## Why this is stateful
 *
 * Stella's `tool_result` carries `call_id`, `output` and `duration_ms` — and no
 * tool name or input, both of which live on the `tool_start` that preceded it.
 * `CodingEvent`'s `tool-result` requires all four. So the mapper carries a
 * per-turn `call_id → (name, input)` table, which is why it is a factory rather
 * than a pure function. Same shape, same reason, as the transcript mapper's
 * `toolName` table.
 *
 * ## What is dropped, and why that is safe
 *
 * Stella's event vocabulary is roughly thirty variants; `CodingEvent` has
 * seven. An event with no `CodingEvent` spelling returns `undefined` here and
 * is **not** lost: {@link runStellaTurn} forwards every raw frame to
 * `onStreamPart` first, which is the higher-fidelity tap the in-app SSE
 * translator already consumes. Mapping is the lossy projection; the raw tap is
 * the record.
 *
 * `file-edit`, `command` and `final-diff` are deliberately absent from this
 * map. They are host-side facts — the host ran the tool, so the host's own
 * tool wrappers already emit them — and synthesising them from an engine event
 * would double-count.
 */
import type { CodingEvent } from "@oxagen/agent-engine";
import type { AgentEventEnvelope } from "@oxagen/stella-engine-client";

/** Caps matching `engine.ts`'s own `tool-result` event, so both engines' rows are comparable. */
const INPUT_CAP = 1000;
const RESULT_CAP = 2000;

export interface StellaEventMapper {
  /** Map one frame, or `undefined` when it has no `CodingEvent` spelling. */
  map(event: AgentEventEnvelope): CodingEvent | undefined;
  /** Tool calls seen so far — the step count a `RunCodingAgentResult` reports. */
  readonly toolCallCount: number;
}

export function createEventMapper(): StellaEventMapper {
  const calls = new Map<string, { name: string; input: unknown }>();
  let toolCallCount = 0;

  return {
    get toolCallCount() {
      return toolCallCount;
    },
    map(event) {
      switch (event.type) {
        // `delta` is the field; `text` is its serde alias upstream, so accept
        // both rather than depending on which spelling a given build emits.
        case "text_delta":
        case "text": {
          const delta =
            stringField(event, "delta") ?? stringField(event, "text");
          return delta === undefined ? undefined : { type: "text", delta };
        }

        case "reasoning": {
          const delta = stringField(event, "delta");
          return delta === undefined ? undefined : { type: "reasoning", delta };
        }

        case "tool_start": {
          const call = record(event.call);
          const name = call && stringField(call, "name");
          if (!call || name === undefined) return undefined;
          const callId = stringField(call, "call_id");
          const input = call.input;
          if (callId !== undefined) calls.set(callId, { name, input });
          toolCallCount += 1;
          return { type: "tool-call", name, input };
        }

        case "tool_result": {
          const callId = stringField(event, "call_id");
          if (callId === undefined) return undefined;
          const started = calls.get(callId);
          const output = event.output;
          return {
            type: "tool-result",
            // A result whose start was never seen still belongs in the log;
            // an empty name is a visible gap, a dropped row is an invisible one.
            name: started?.name ?? "",
            input: capped(started?.input, INPUT_CAP),
            result: capped(renderOutput(output), RESULT_CAP),
            durationMs: numberField(event, "duration_ms") ?? 0,
            ok: isOkOutput(output),
          };
        }

        default:
          return undefined;
      }
    },
  };
}

/**
 * Stella's externally-tagged `ToolOutput` — `{"ok":{…}}` / `{"error":{…}}`.
 * Anything else is treated as a failure, because an output this code cannot
 * read is not one it may report as success.
 */
function isOkOutput(output: unknown): boolean {
  const shape = record(output);
  return shape !== undefined && "ok" in shape;
}

function renderOutput(output: unknown): unknown {
  const shape = record(output);
  if (!shape) return output;
  const ok = record(shape.ok);
  if (ok && typeof ok.content === "string") return ok.content;
  const error = record(shape.error);
  if (error && typeof error.message === "string") return error.message;
  return output;
}

/** Mirrors `engine.ts`'s `stringifyCapped` so both engines truncate alike. */
function capped(value: unknown, max: number): string {
  let text: string;
  try {
    text =
      typeof value === "string"
        ? value
        : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  source: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
