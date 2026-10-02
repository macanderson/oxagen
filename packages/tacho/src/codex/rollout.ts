/**
 * Codex rollout records to the model calls they describe. Pure.
 *
 * Codex writes each thread to a rollout file under `~/.codex/sessions/`, one
 * JSON object per line: `{"timestamp", "ordinal", "type", "payload"}`. The
 * hook payload names the file as `transcript_path`, and the tailer reads it
 * the way it reads a Claude Code transcript. Hooks already record the
 * prompts, the tool calls and their results, so this reader emits one thing:
 * an `llm_call` for each model response, with the response's usage and its
 * visible output as the body.
 *
 * One response is several lines. Codex writes the response's items as they
 * finish (`response_item` lines: `reasoning`, an assistant `message` with
 * `output_text`, a `function_call` or `custom_tool_call`), then one
 * `token_usage_record` once the response completes. That record carries the
 * response id (`resp_…`) and the response's usage, and no item does. So the
 * reader holds the items' text until the record arrives, and the state that
 * holds it lives on the file's tail cursor, persisted with the offset, so a
 * restart between the two lines loses nothing (`CodexRolloutState`).
 *
 * The response id is the key the gateway's frame carries too: the model
 * proxy stores the Responses API `response.id` as the `llm_call`'s
 * `message_id`. The frame this reader drafts sets `message_id` to the same
 * id, so the recorder's model call ledger stamps it a later sighting of the
 * proxy's frame and the call counts once (ADR-262).
 *
 * Measured on 2026-10-02 against 263 rollouts written by Codex 0.150 to
 * 0.159.2 on one host:
 *
 * - Between an assistant message and the record that closes its response,
 *   no `token_count` event and no turn boundary appeared (2,465 responses).
 * - 56 messages had no record of their own, and in every one a
 *   `token_count` event came before the next response's record. Most often
 *   an inter-agent message had cut the response short. A `token_count`
 *   therefore ends the response in hand, and its text is dropped rather than
 *   put on the next response's frame.
 * - Rollouts imported from another agent, and the history a forked subagent
 *   copies from its parent, hold assistant messages with no record. Neither
 *   is a call this thread made, and neither seals a frame.
 */
import type {
  TranscriptDraft,
  TranscriptNormalized,
} from "../claude-code/transcript";
import { digestJcs, type JsonValue } from "../digest";
import { textContent } from "../evidence/frame-body";
import { TACHO_MAX_BODY_BYTES } from "../wire";

/** The response a rollout is writing, held until its usage record arrives. */
interface HeldResponse {
  /** The body so far: each text block, and each tool request as a JSON line. */
  parts: string[];
  /** The UTF-16 length of `parts` joined with newlines. */
  length: number;
  /** The type of each item the response wrote, in order. */
  kinds: string[];
  /** The `call_id` of each tool request. */
  calls: string[];
  /** The turn the response's first item named. */
  turnId?: string;
  /**
   * Set once the body grew past `TACHO_MAX_BODY_BYTES`. A body that long is
   * not shipped, so the text is not held, and the frame says why it has none.
   */
  tooLarge?: true;
}

/**
 * What the reader keeps from one line of a rollout to the next. The tailer
 * persists it on the file's cursor, beside the offset, so the state always
 * matches the lines the cursor has moved past. Plain JSON, no class.
 */
export interface CodexRolloutState {
  /** Set once the file's first `session_meta` has been read. */
  meta?: true;
  /** The model provider that `session_meta` named, such as `openai`. */
  provider?: string;
  /**
   * The first ordinal that is this thread's own. A forked subagent's rollout
   * starts with the history it copied from its parent, records included,
   * and `session_meta.subagent_history_start_ordinal` says where that ends.
   */
  historyStart?: number;
  /** The model the latest `turn_context` named. */
  model?: string;
  /** The response being written. */
  held?: HeldResponse;
  /** Record types this reader does not know, each with the lines it skipped. */
  unknown?: Record<string, number>;
  /** Responses whose items were dropped because no usage record closed them. */
  orphaned?: number;
}

/**
 * What a transcript normalizer keeps between the lines of one file. The tail
 * cursor is one, so the tailer hands its cursor in, and the normalizer's
 * state persists with the offset it belongs to.
 */
export interface TranscriptCarry {
  codex?: CodexRolloutState;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

/** A non-empty string the envelope's 512-unit `short` bound can hold. */
function short(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** The top-level record types Codex 0.159 writes (`RolloutItem`). */
const KNOWN_RECORDS: ReadonlySet<string> = new Set([
  "session_meta",
  "response_item",
  "event_msg",
  "turn_context",
  "token_usage_record",
  "world_state",
  "compacted",
  "inter_agent_communication",
  "inter_agent_communication_metadata",
  "retained_context",
  "security_risk_score",
  "realtime_item",
]);

/**
 * The `response_item` types that are input to the next request, not output
 * of a response: prompts, tool results, messages from other agents, and
 * context Codex manages. Known, and nothing to read.
 */
const INPUT_ITEMS: ReadonlySet<string> = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
  "agent_message",
  "additional_tools",
  "compaction",
  "configuration_update",
  "compaction_trigger",
  "context_compaction",
  "other",
]);

/**
 * The `response_item` types a model response writes as a tool request, and
 * the tool name each gets when the item names none.
 */
const TOOL_ITEMS: Readonly<Record<string, string>> = {
  function_call: "function",
  custom_tool_call: "custom_tool",
  local_shell_call: "local_shell",
  web_search_call: "web_search",
  tool_search_call: "tool_search",
  image_generation_call: "image_generation",
};

/** The `event_msg` types that start or end a turn. */
const TURN_EVENTS: ReadonlySet<string> = new Set([
  "task_started",
  "task_complete",
  "turn_aborted",
]);

/** The most record types `unknown` names; any more count under one key. */
const UNKNOWN_TYPES_MAX = 16;
/** The longest record type `unknown` keeps as a key. */
const UNKNOWN_TYPE_CHARS = 64;
/** The most item types and call ids a frame lists in its attrs. */
const KINDS_MAX = 64;
const CALLS_MAX = 32;

/** The text of an assistant message: its `output_text` blocks. */
function messageText(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    const item = rec(block);
    if (item?.["type"] !== "output_text") continue;
    const text = item["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }
  return parts;
}

/** A function call's arguments as JSON when they parse, else as sent. */
function argumentsOf(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * A tool request as one line of the body, in the shape the Claude Code
 * transcript reader writes a `tool_use` block (`assistantMessageText`), so a
 * replay reads what the model said and what it asked for the same way for
 * both harnesses.
 */
function toolLine(type: string, item: Rec): { line: string; call?: string } {
  const call = short(item["call_id"]) ?? short(item["id"]);
  const input =
    type === "function_call" || type === "tool_search_call"
      ? argumentsOf(item["arguments"])
      : type === "custom_tool_call"
        ? (item["input"] ?? null)
        : type === "image_generation_call"
          ? null
          : (item["action"] ?? null);
  const line = JSON.stringify({
    tool_use: {
      ...(call !== undefined ? { id: call } : {}),
      name: short(item["name"]) ?? TOOL_ITEMS[type],
      input,
    },
  });
  return call !== undefined ? { line, call } : { line };
}

/** The turn id Codex stamps on an item it wrote. */
function itemTurn(item: Rec): string | undefined {
  const metadata = rec(item["internal_chat_message_metadata_passthrough"]);
  return short(metadata?.["turn_id"]);
}

/** The state with one more line skipped under `type`. */
function countUnknown(
  state: CodexRolloutState,
  type: string,
): CodexRolloutState {
  const unknown = { ...state.unknown };
  const cut = type.slice(0, UNKNOWN_TYPE_CHARS);
  // A key the object prototype owns would not count as a plain member.
  const named = cut in Object.prototype ? `(${cut})` : cut;
  const key =
    Object.hasOwn(unknown, named) ||
    Object.keys(unknown).length < UNKNOWN_TYPES_MAX
      ? named
      : "(more)";
  unknown[key] = (unknown[key] ?? 0) + 1;
  return { ...state, unknown };
}

/**
 * The state with the response in hand dropped: nothing closed it, so it is
 * not a call this thread can account for (see the module comment).
 */
function dropHeld(state: CodexRolloutState): CodexRolloutState {
  if (state.held === undefined) return state;
  const { held, ...rest } = state;
  return held.parts.length > 0 || held.tooLarge === true
    ? { ...rest, orphaned: (state.orphaned ?? 0) + 1 }
    : rest;
}

/** The state with one item of the response in hand added. */
function holdItem(
  state: CodexRolloutState,
  kind: string,
  item: Rec,
  parts: string[],
  call: string | undefined,
): CodexRolloutState {
  const held: HeldResponse = state.held ?? {
    parts: [],
    length: 0,
    kinds: [],
    calls: [],
  };
  const turnId = held.turnId ?? itemTurn(item);
  const next: HeldResponse = {
    parts: held.parts,
    length: held.length,
    kinds: held.kinds.length < KINDS_MAX ? [...held.kinds, kind] : held.kinds,
    calls:
      call !== undefined && held.calls.length < CALLS_MAX
        ? [...held.calls, call]
        : held.calls,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(held.tooLarge === true ? { tooLarge: true as const } : {}),
  };
  if (next.tooLarge !== true && parts.length > 0) {
    const added = parts.reduce(
      (sum, part) => sum + part.length + 1,
      next.parts.length === 0 ? -1 : 0,
    );
    if (next.length + added > TACHO_MAX_BODY_BYTES) {
      next.parts = [];
      next.length = 0;
      next.tooLarge = true;
    } else {
      next.parts = [...next.parts, ...parts];
      next.length += added;
    }
  }
  return { ...state, held: next };
}

/** The `llm_call` body a usage record and the session's facts make. */
function callBody(state: CodexRolloutState, payload: Rec): Rec {
  const usage = rec(payload["usage"]);
  const body: Rec = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };
  set("provider", state.provider);
  set("model", state.model);
  set("message_id", short(payload["response_id"]));
  // The proxy folds an OpenAI usage block this way (`foldOpenAiUsage`):
  // `input_tokens` there includes the cached part, and the chain's figure
  // does not.
  const input = count(usage?.["input_tokens"]);
  const cached = count(usage?.["cached_input_tokens"]);
  set(
    "input_tokens",
    input === undefined ? undefined : Math.max(0, input - (cached ?? 0)),
  );
  set("output_tokens", count(usage?.["output_tokens"]));
  set("cache_read_tokens", cached);
  set("cache_creation_tokens", count(usage?.["cache_write_input_tokens"]));
  set("thinking_tokens", count(usage?.["reasoning_output_tokens"]));
  return body;
}

/**
 * The frame a usage record closes the response in hand with. The body is
 * the response's text and tool requests; a response that wrote neither
 * (only reasoning) gets an empty body, since it had nothing visible to keep.
 * A response whose items this reader did not hold, because they named
 * another turn or were too long, gets no body, and the frame shows the gap.
 */
function closeResponse(
  state: CodexRolloutState,
  record: Rec,
  payload: Rec,
  ts: string,
): { draft: TranscriptDraft; state: CodexRolloutState } {
  const turnId = short(payload["turn_id"]);
  let held = state.held;
  let next: CodexRolloutState = state;
  if (
    held?.turnId !== undefined &&
    turnId !== undefined &&
    held.turnId !== turnId
  ) {
    next = dropHeld(state);
    held = undefined;
  }
  const { held: _closed, ...rest } = next;
  const attrs: Record<string, string> = {};
  if (held !== undefined && held.kinds.length > 0)
    attrs["transcript.content_block_types"] = JSON.stringify(held.kinds);
  if (held !== undefined && held.calls.length > 0)
    attrs["transcript.tool_use_ids"] = JSON.stringify(held.calls);
  if (held?.tooLarge === true) attrs["body_omitted"] = "too_large";
  const content =
    held === undefined || held.tooLarge === true
      ? undefined
      : textContent(held.parts.join("\n"));
  const draft: TranscriptDraft = {
    kind: "llm_call",
    ts,
    body: callBody(state, payload),
    attrs,
    context: {},
    ...(turnId !== undefined ? { turn: { turn_id: turnId } } : {}),
    raw_source_digest: digestJcs(record as JsonValue),
    ...(content !== undefined ? { content } : {}),
  };
  return { draft, state: rest };
}

function tsOf(record: Rec, fallback: string): string {
  const value = record["timestamp"];
  if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
    return new Date(value).toISOString();
  return fallback;
}

const NOTHING: TranscriptNormalized = { drafts: [], totals: {} };

/**
 * Read one rollout line against the state the lines before it left, and
 * answer the frames it closes and the state for the next line. The state
 * passed in is not changed.
 */
export function normalizeRolloutLine(
  line: string,
  previous: CodexRolloutState | undefined,
  fallbackTs: string,
): { normalized: TranscriptNormalized; state: CodexRolloutState } {
  const state: CodexRolloutState = previous ?? {};
  const trimmed = line.trim();
  if (trimmed === "") return { normalized: NOTHING, state };
  let record: Rec | undefined;
  try {
    record = rec(JSON.parse(trimmed) as unknown);
  } catch {
    record = undefined;
  }
  if (record === undefined)
    return { normalized: NOTHING, state: countUnknown(state, "(not json)") };
  const rawType = record["type"];
  const type = typeof rawType === "string" ? rawType : undefined;
  const payload = rec(record["payload"]) ?? {};
  if (type === "session_meta") {
    // A forked thread copies its parent's `session_meta` after its own. Only
    // the file's first one describes this thread.
    if (state.meta === true) return { normalized: NOTHING, state };
    const historyStart = count(payload["subagent_history_start_ordinal"]);
    const provider = short(payload["model_provider"]);
    return {
      normalized: NOTHING,
      state: {
        ...state,
        meta: true,
        ...(provider !== undefined ? { provider } : {}),
        ...(historyStart !== undefined ? { historyStart } : {}),
      },
    };
  }
  const ordinal = count(record["ordinal"]);
  if (
    state.historyStart !== undefined &&
    ordinal !== undefined &&
    ordinal < state.historyStart
  )
    return { normalized: NOTHING, state };
  if (type === undefined || !KNOWN_RECORDS.has(type))
    return {
      normalized: NOTHING,
      state: countUnknown(state, type ?? "(untyped)"),
    };
  switch (type) {
    case "turn_context": {
      const model = short(payload["model"]);
      const next = dropHeld(state);
      return {
        normalized: NOTHING,
        state: model !== undefined ? { ...next, model } : next,
      };
    }
    case "compacted":
      return { normalized: NOTHING, state: dropHeld(state) };
    case "event_msg": {
      const event = payload["type"];
      if (event === "token_count" || TURN_EVENTS.has(event as string))
        return { normalized: NOTHING, state: dropHeld(state) };
      return { normalized: NOTHING, state };
    }
    case "token_usage_record": {
      const ts = tsOf(record, fallbackTs);
      const closed = closeResponse(state, record, payload, ts);
      return {
        normalized: { drafts: [closed.draft], totals: {} },
        state: closed.state,
      };
    }
    case "response_item": {
      const rawItem = payload["type"];
      const item = typeof rawItem === "string" ? rawItem : "";
      if (item === "message") {
        if (payload["role"] !== "assistant")
          return { normalized: NOTHING, state };
        return {
          normalized: NOTHING,
          state: holdItem(
            state,
            item,
            payload,
            messageText(payload["content"]),
            undefined,
          ),
        };
      }
      if (item === "reasoning")
        return {
          normalized: NOTHING,
          state: holdItem(state, item, payload, [], undefined),
        };
      if (Object.hasOwn(TOOL_ITEMS, item)) {
        const tool = toolLine(item, payload);
        return {
          normalized: NOTHING,
          state: holdItem(state, item, payload, [tool.line], tool.call),
        };
      }
      if (INPUT_ITEMS.has(item)) return { normalized: NOTHING, state };
      return {
        normalized: NOTHING,
        state: countUnknown(state, `response_item:${item || "(untyped)"}`),
      };
    }
    default:
      return { normalized: NOTHING, state };
  }
}
