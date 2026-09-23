/**
 * Reassembly: a recorded model stream folded into the message it was
 * (Mission Control spec §14; ADR-058).
 *
 * A model response is recorded as the bytes that crossed the wire, which for
 * a streaming provider is a server-sent event stream: a few thousand
 * `content_block_delta` envelopes carrying a few characters each. Those bytes
 * are the record and they never change. They are also not the message, and a
 * surface that renders them renders roughly six parts JSON envelope to one
 * part text, then cuts the result mid-token because the cut is measured on
 * the envelope.
 *
 * So the fold happens ONCE, where the frame is written, and the result is
 * stored beside the wire. Nothing downstream reassembles: a viewer reads
 * blocks, and reaches for the wire only when a person asks for the transport.
 *
 * Everything here is pure and has no dependency beyond the standard library,
 * so the ingest handlers, the read handlers and the tests all fold the same
 * bytes the same way.
 *
 * What the fold guarantees:
 *
 *   - Blocks are folded by the `index` the envelope carries, never by arrival
 *     order, so interleaved blocks land where the provider put them.
 *   - A `tool_use` block's `input_json_delta` fragments accumulate as a string
 *     and parse at `content_block_stop`. A fragment set that does not parse
 *     keeps the raw string and marks the block partial rather than dropping
 *     the call the agent made.
 *   - Every block carries a stable id, so a deep link to one survives a
 *     reload.
 *   - A stream cut off mid-block keeps the block and marks it partial. A
 *     truncated recording is evidence of a truncated run; rendering nothing
 *     would report it as a run that did nothing.
 */

/** A JSON value, as a tool call's parsed input. */
export type BlockJson =
  | null
  | boolean
  | number
  | string
  | BlockJson[]
  | { [key: string]: BlockJson };

/** What a rule or a person decided about a tool call. */
export interface ToolVerdict {
  answer: "allowed" | "denied" | "routed";
  /** The rule that answered, as the record spells it. */
  rule: string;
  /** How long the decision took, when the record timed it. */
  ms: number | null;
  /** Who the call is waiting on while it is routed; null otherwise. */
  waitingOn: string | null;
}

interface BlockBase {
  /** Stable within the frame: `b<index>`. A deep link survives a reload. */
  id: string;
  /** Characters of rendered text (tool input counted as its JSON). */
  chars: number;
  /**
   * The block's share of the message's output tokens, apportioned by
   * characters. The provider counts tokens for the message, never per block,
   * so this is the only honest split available and it is named as an
   * apportionment, not a measurement.
   */
  tokens: number;
  /** True when the stream ended before this block closed. */
  partial: boolean;
}

export interface TextBlock extends BlockBase {
  kind: "text";
  text: string;
}

export interface ThinkingBlock extends BlockBase {
  kind: "thinking";
  text: string;
  /** Wall seconds the block took, when the record timed it. */
  seconds: number | null;
}

export interface ToolUseBlock extends BlockBase {
  kind: "tool_use";
  name: string;
  /** The parsed input, or the raw fragment string when it did not parse. */
  input: BlockJson;
  /** True when `input` is the raw string rather than parsed JSON. */
  inputRaw: boolean;
  /** The producer's own id for the call, so a result attaches to it. */
  callKey: string | null;
  verdict: ToolVerdict | null;
}

export interface ToolResultBlock extends BlockBase {
  kind: "tool_result";
  /** The `tool_use` block this result answers. */
  forId: string;
  ok: boolean;
  /** One line: what came back, never the whole payload. */
  summary: string;
  bytes: number | null;
  ms: number | null;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

/** The token counts the provider reported, split so no total hides a cache hit. */
export interface AssemblyUsage {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
}

/** What the transport was, for the tier that shows it. */
export interface WireShape {
  /** Server-sent events counted in the recorded bytes. */
  events: number;
  /** The recorded bytes' length. */
  bytes: number;
}

/**
 * One recorded model stream, folded. `MESSAGE_ASSEMBLY_VERSION` is stamped on
 * the stored object so a fold this module later improves is recomputed rather
 * than read back from a stale cache.
 */
export interface MessageAssembly {
  version: number;
  blocks: ContentBlock[];
  /** The provider's stop reason, verbatim; null when the stream did not say. */
  stopReason: string | null;
  /** Milliseconds to the first content delta; null when the record did not time it. */
  ttftMs: number | null;
  /** The call's wall time; null when the record did not time it. */
  durationMs: number | null;
  usage: AssemblyUsage;
  /** True when the stream ended before the message did. */
  partial: boolean;
  wire: WireShape;
}

export const MESSAGE_ASSEMBLY_VERSION = 2;

export const MESSAGE_ASSEMBLY_CONTENT_TYPE =
  "application/vnd.oxagen.assembly+json";

/** Roughly four characters to the token: the apportionment's divisor. */
const CHARS_PER_TOKEN = 4;

/** The longest tool-result summary a block carries; the payload is elsewhere. */
const SUMMARY_MAX = 180;

interface Draft {
  index: number;
  kind: ContentBlock["kind"];
  text: string;
  /** `input_json_delta` fragments, joined at stop. */
  json: string;
  name: string | null;
  callKey: string | null;
  closed: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
}

function draft(index: number, kind: ContentBlock["kind"]): Draft {
  return {
    index,
    kind,
    text: "",
    json: "",
    name: null,
    callKey: null,
    closed: false,
    startedAt: null,
    stoppedAt: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(
  source: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

function num(
  source: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * One server-sent event's `data` payload, parsed.
 *
 * The stream is `event: <name>` and `data: <json>` lines separated by blank
 * lines, and a `data:` may be split over several lines. Anything that is not
 * JSON is skipped rather than failing the fold: a recorder that wrote a
 * provider's keep-alive comment must not cost the reader the message.
 */
function* sseEvents(wire: string): Generator<Record<string, unknown>> {
  let data = "";
  for (const raw of wire.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      if (data !== "") {
        try {
          const parsed: unknown = JSON.parse(data);
          const record = asRecord(parsed);
          if (record !== null) yield record;
        } catch {
          // Not JSON: the transport's, not the message's.
        }
        data = "";
      }
      continue;
    }
    if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
      continue;
    }
    // `event:`, `id:`, `retry:` and comments name the envelope, not the body.
  }
  if (data !== "") {
    try {
      const parsed: unknown = JSON.parse(data);
      const record = asRecord(parsed);
      if (record !== null) yield record;
    } catch {
      // A stream cut mid-event: the drafts already folded still stand.
    }
  }
}

/**
 * Does this body look like a recorded model stream? A frame whose bytes are a
 * prompt, a tool argument or a JSON response is not folded, and the caller
 * renders its text as it always did.
 */
export function looksLikeModelStream(wire: string): boolean {
  const head = responseWire(wire).slice(0, 4096);
  return (
    head.includes("event: content_block_delta") ||
    head.includes("event: message_start") ||
    /^\s*(event|data):/.test(head)
  );
}

function responseWire(wire: string): string {
  if (!wire.trimStart().startsWith("{")) return wire;
  try {
    const exchange = asRecord(JSON.parse(wire));
    if (typeof exchange?.response !== "string") return wire;
    // `request` may be absent: a request over the cap, or a call this build
    // could not fold within it, ships `{"response":...}` alone (JCS drops
    // the member with no bytes; `model-proxy.ts`'s `exchangeContent`). The
    // response still renders; only the request half is missing. A `request`
    // that is present but not a string is not this shape at all, and is left
    // alone rather than guessed at.
    if (exchange.request !== undefined && typeof exchange.request !== "string")
      return wire;
    return exchange.response;
  } catch {
    return wire;
  }
}

function blockKindOf(type: string | null): ContentBlock["kind"] {
  switch (type) {
    case "thinking":
    case "redacted_thinking":
      return "thinking";
    case "tool_use":
    case "server_tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    default:
      return "text";
  }
}

/** The one-line `summary` a tool result carries: its first line, clamped. */
function summarize(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > SUMMARY_MAX
    ? `${line.slice(0, SUMMARY_MAX - 1)}…`
    : line;
}

function parseJson(raw: string): { value: BlockJson; raw: boolean } {
  if (raw.trim() === "") return { value: {}, raw: false };
  try {
    return { value: JSON.parse(raw) as BlockJson, raw: false };
  } catch {
    return { value: raw, raw: true };
  }
}

/** Characters a draft renders as, which is what the token split is weighted by. */
function charsOf(draft: Draft): number {
  return draft.kind === "tool_use" ? draft.json.length : draft.text.length;
}

/**
 * Apportion `outputTokens` across the blocks by their own characters, so the
 * shares sum to the reported total exactly. The remainder from the rounding
 * goes to the largest block, which is the one it is smallest against.
 */
function apportion(
  chars: readonly number[],
  outputTokens: number | null,
): number[] {
  const total = chars.reduce((sum, n) => sum + n, 0);
  if (total === 0) return chars.map(() => 0);
  if (outputTokens === null) {
    return chars.map((n) => Math.round(n / CHARS_PER_TOKEN));
  }
  const shares = chars.map((n) => Math.floor((outputTokens * n) / total));
  const assigned = shares.reduce((sum, n) => sum + n, 0);
  let remainder = outputTokens - assigned;
  // Largest first, so the leftovers land where they distort least.
  const order = chars
    .map((n, i) => ({ n, i }))
    .sort((a, b) => b.n - a.n)
    .map((entry) => entry.i);
  for (const index of order) {
    if (remainder <= 0) break;
    shares[index] = (shares[index] as number) + 1;
    remainder -= 1;
  }
  return shares;
}

/** What the recorder timed, when it timed anything. */
export interface AssemblyTiming {
  ttftMs?: number | null;
  durationMs?: number | null;
}

/**
 * Fold one recorded model stream into the message it was.
 *
 * `wire` is the recorded bytes decoded as UTF-8 — the record, unchanged.
 * `timing` is what the frame's own receipt timed, which the stream itself
 * cannot say: the bytes carry no clock.
 *
 * Answers null when the bytes are neither a streamed model response nor one
 * of the three vendor shapes a `stream: false` call answers with, so the
 * caller keeps showing the body it already showed.
 */
export function assembleModelStream(
  wire: string,
  timing: AssemblyTiming = {},
): MessageAssembly | null {
  if (looksLikeModelStream(wire)) return assembleSseStream(wire, timing);
  return assembleNonStreamedDocument(wire, timing);
}

/** The SSE half of `assembleModelStream`: Anthropic and OpenAI's streamed shapes. */
function assembleSseStream(
  wire: string,
  timing: AssemblyTiming,
): MessageAssembly | null {
  const drafts = new Map<number, Draft>();
  const order: number[] = [];
  let stopReason: string | null = null;
  let events = 0;
  let sawMessage = false;
  let ended = false;
  const usage: AssemblyUsage = {
    inputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
  };

  const at = (index: number, kind: ContentBlock["kind"]): Draft => {
    const held = drafts.get(index);
    if (held !== undefined) return held;
    const made = draft(index, kind);
    drafts.set(index, made);
    order.push(index);
    return made;
  };

  // Responses identifies a part by its output item and content index.
  const responseIndices = new Map<string, number>();
  const responseAt = (
    output: number,
    part: number,
    kind: ContentBlock["kind"],
  ): Draft => {
    const key = `${output}:${part}`;
    let index = responseIndices.get(key);
    if (index === undefined) {
      index = responseIndices.size;
      responseIndices.set(key, index);
    }
    return at(index, kind);
  };
  const responseItem = (
    item: Record<string, unknown> | null,
    output: number,
    closed: boolean,
  ) => {
    if (item === null) return;
    if (item.type === "function_call") {
      const held = responseAt(output, 0, "tool_use");
      held.name = str(item, "name") ?? held.name;
      held.callKey = str(item, "call_id") ?? held.callKey;
      held.json = str(item, "arguments") ?? held.json;
      held.closed = closed;
    } else {
      const parts = item.type === "reasoning" ? item.summary : item.content;
      if (!Array.isArray(parts)) return;
      parts.forEach((part: unknown, index: number) => {
        const record = asRecord(part);
        const text = str(record, "text") ?? str(record, "refusal");
        if (text === null) return;
        const held = responseAt(
          output,
          index,
          item.type === "reasoning" ? "thinking" : "text",
        );
        held.text = text;
        held.closed = closed;
      });
    }
  };

  // OpenAI Chat Completions chunks carry no `type` field at all — they are
  // told apart by `choices`, which every chunk carries, empty in the
  // trailing one `stream_options.include_usage` adds to report usage once
  // the message is done. Chat Completions has one text stream, not an
  // indexed array of content blocks, so its deltas fold into a fixed index;
  // tool calls get their own indices, offset clear of it.
  const CHAT_COMPLETION_TEXT_INDEX = 0;
  const chatCompletionToolIndex = (toolIndex: number): number =>
    1000 + toolIndex;
  const foldChatCompletionChunk = (event: Record<string, unknown>): void => {
    sawMessage = true;
    const choices = event["choices"];
    if (Array.isArray(choices)) {
      for (const raw of choices) {
        const choice = asRecord(raw);
        if (choice === null) continue;
        const finish = str(choice, "finish_reason");
        const delta = asRecord(choice["delta"]);
        const content = str(delta, "content");
        if (content !== null) {
          at(CHAT_COMPLETION_TEXT_INDEX, "text").text += content;
        }
        const toolCalls = delta?.["tool_calls"];
        if (Array.isArray(toolCalls)) {
          for (const rawCall of toolCalls) {
            const call = asRecord(rawCall);
            if (call === null) continue;
            const held = at(
              chatCompletionToolIndex(num(call, "index") ?? 0),
              "tool_use",
            );
            const fn = asRecord(call["function"]);
            const name = str(fn, "name");
            if (name !== null) held.name = name;
            held.json += str(fn, "arguments") ?? "";
            const id = str(call, "id");
            if (id !== null) held.callKey = id;
          }
        }
        if (finish !== null) {
          stopReason = finish;
          ended = true;
          // Chat Completions signals the end once, on a chunk that carries
          // no further content of its own: every block folded so far for
          // this stream closes together, not just whichever one this
          // particular chunk happened to touch.
          for (const held of drafts.values()) held.closed = true;
        }
      }
    }
    const reported = asRecord(event["usage"]);
    if (reported !== null) {
      const cached = num(
        asRecord(reported["prompt_tokens_details"]),
        "cached_tokens",
      );
      const prompt = num(reported, "prompt_tokens");
      if (prompt !== null) usage.inputTokens = prompt - (cached ?? 0);
      if (cached !== null) usage.cacheReadTokens = cached;
      const completion = num(reported, "completion_tokens");
      if (completion !== null) usage.outputTokens = completion;
    }
  };

  for (const event of sseEvents(responseWire(wire))) {
    events += 1;
    const type = str(event, "type");
    if (type === null && Array.isArray(event["choices"])) {
      foldChatCompletionChunk(event);
      continue;
    }
    switch (type) {
      case "response.created":
      case "response.in_progress":
        sawMessage = true;
        break;
      case "response.output_item.added":
      case "response.output_item.done": {
        const output = num(event, "output_index");
        if (output !== null)
          responseItem(asRecord(event.item), output, type.endsWith(".done"));
        break;
      }
      case "response.output_text.delta":
      case "response.output_text.done":
      case "response.refusal.delta":
      case "response.refusal.done":
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
      case "response.function_call_arguments.delta":
      case "response.function_call_arguments.done": {
        const output = num(event, "output_index");
        if (output === null) break;
        const tool = type.startsWith("response.function_call_arguments.");
        const thinking = type.startsWith("response.reasoning_summary_text.");
        const held = responseAt(
          output,
          num(event, thinking ? "summary_index" : "content_index") ?? 0,
          tool ? "tool_use" : thinking ? "thinking" : "text",
        );
        if (type.endsWith(".delta")) {
          if (tool) held.json += str(event, "delta") ?? "";
          else held.text += str(event, "delta") ?? "";
        } else {
          if (tool) held.json = str(event, "arguments") ?? held.json;
          else
            held.text =
              str(event, "text") ?? str(event, "refusal") ?? held.text;
          held.closed = true;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        sawMessage = true;
        ended = type === "response.completed";
        const response = asRecord(event.response);
        stopReason =
          str(asRecord(response?.incomplete_details), "reason") ??
          str(response, "status");
        const reported = asRecord(response?.usage);
        const cached = num(
          asRecord(reported?.input_tokens_details),
          "cached_tokens",
        );
        const input = num(reported, "input_tokens");
        usage.inputTokens = input === null ? null : input - (cached ?? 0);
        usage.cacheReadTokens = cached;
        usage.outputTokens = num(reported, "output_tokens");
        if (Array.isArray(response?.output)) {
          response.output.forEach((item: unknown, index: number) =>
            responseItem(
              asRecord(item),
              index,
              ended || asRecord(item)?.status === "completed",
            ),
          );
        }
        break;
      }
      case "message_start": {
        sawMessage = true;
        const message = asRecord(event.message);
        const reported = asRecord(message?.usage);
        usage.inputTokens = num(reported, "input_tokens");
        usage.cacheReadTokens = num(reported, "cache_read_input_tokens");
        usage.cacheWriteTokens = num(reported, "cache_creation_input_tokens");
        const out = num(reported, "output_tokens");
        if (out !== null) usage.outputTokens = out;
        break;
      }
      case "content_block_start": {
        const index = num(event, "index");
        if (index === null) break;
        const block = asRecord(event.content_block);
        const held = at(index, blockKindOf(str(block, "type")));
        held.kind = blockKindOf(str(block, "type"));
        held.name = str(block, "name");
        held.callKey = str(block, "id") ?? str(block, "tool_use_id");
        // A non-streamed block arrives whole on the start envelope.
        const whole = str(block, "text") ?? str(block, "thinking");
        if (whole !== null) held.text += whole;
        break;
      }
      case "content_block_delta": {
        const index = num(event, "index");
        if (index === null) break;
        const delta = asRecord(event.delta);
        const deltaType = str(delta, "type");
        const held = at(
          index,
          deltaType === "input_json_delta"
            ? "tool_use"
            : deltaType === "thinking_delta"
              ? "thinking"
              : "text",
        );
        if (deltaType === "input_json_delta") {
          held.json += str(delta, "partial_json") ?? "";
        } else {
          held.text +=
            str(delta, "text") ??
            str(delta, "thinking") ??
            str(delta, "partial_text") ??
            "";
        }
        break;
      }
      case "content_block_stop": {
        const index = num(event, "index");
        if (index === null) break;
        const held = drafts.get(index);
        if (held !== undefined) held.closed = true;
        break;
      }
      case "message_delta": {
        const delta = asRecord(event.delta);
        stopReason = str(delta, "stop_reason") ?? stopReason;
        const reported = asRecord(event.usage);
        const out = num(reported, "output_tokens");
        if (out !== null) usage.outputTokens = out;
        const read = num(reported, "cache_read_input_tokens");
        if (read !== null) usage.cacheReadTokens = read;
        const write = num(reported, "cache_creation_input_tokens");
        if (write !== null) usage.cacheWriteTokens = write;
        const input = num(reported, "input_tokens");
        if (input !== null) usage.inputTokens = input;
        break;
      }
      case "message_stop": {
        ended = true;
        break;
      }
      default:
        break;
    }
  }

  // Bytes that carried SSE framing but no message at all are not a model
  // stream after all, whatever the head looked like.
  if (!sawMessage && order.length === 0) return null;

  const held = order
    .slice()
    .sort((a, b) => {
      const keys = [...responseIndices.entries()];
      const left = keys
        .find(([, index]) => index === a)?.[0]
        .split(":")
        .map(Number);
      const right = keys
        .find(([, index]) => index === b)?.[0]
        .split(":")
        .map(Number);
      return left && right
        ? left[0]! - right[0]! || left[1]! - right[1]!
        : a - b;
    })
    .flatMap((index) => {
      const entry = drafts.get(index);
      return entry === undefined ? [] : [entry];
    });
  const chars = held.map(charsOf);
  const tokens = apportion(chars, usage.outputTokens);

  const blocks: ContentBlock[] = held.map((entry, i) => {
    const base = {
      id: `b${entry.index}`,
      chars: chars[i] as number,
      tokens: tokens[i] as number,
      partial: !entry.closed,
    };
    if (entry.kind === "tool_use") {
      const parsed = parseJson(entry.json);
      return {
        ...base,
        kind: "tool_use",
        name: entry.name ?? "tool",
        input: parsed.value,
        inputRaw: parsed.raw,
        callKey: entry.callKey,
        verdict: null,
        partial: base.partial || parsed.raw,
      } satisfies ToolUseBlock;
    }
    if (entry.kind === "thinking") {
      return { ...base, kind: "thinking", text: entry.text, seconds: null };
    }
    if (entry.kind === "tool_result") {
      return {
        ...base,
        kind: "tool_result",
        forId: entry.callKey ?? base.id,
        ok: true,
        summary: summarize(entry.text),
        bytes: entry.text.length,
        ms: null,
      };
    }
    return { ...base, kind: "text", text: entry.text };
  });

  return {
    version: MESSAGE_ASSEMBLY_VERSION,
    blocks,
    stopReason,
    ttftMs: timing.ttftMs ?? null,
    durationMs: timing.durationMs ?? null,
    usage,
    partial: !ended || blocks.some((block) => block.partial),
    wire: { events, bytes: Buffer.byteLength(wire, "utf8") },
  };
}

/** One block, before it is apportioned a token share and given an id. */
interface NonStreamedPart {
  kind: ContentBlock["kind"];
  text?: string;
  /** The tool call's arguments, as JSON text (parsed at `finishNonStreamed`). */
  json?: string;
  name?: string | null;
  callKey?: string | null;
}

/**
 * Turn parts read straight off a non-streamed document into blocks: the same
 * shape `assembleSseStream` produces, apportioning `usage.outputTokens`
 * across them by character share the same way.
 */
function finishNonStreamed(
  parts: readonly NonStreamedPart[],
  stopReason: string | null,
  usage: AssemblyUsage,
  timing: AssemblyTiming,
  wire: string,
): MessageAssembly {
  const chars = parts.map((part) =>
    part.kind === "tool_use"
      ? (part.json ?? "").length
      : (part.text ?? "").length,
  );
  const tokens = apportion(chars, usage.outputTokens);
  const blocks: ContentBlock[] = parts.map((part, i) => {
    const base = {
      id: `b${i}`,
      chars: chars[i] as number,
      tokens: tokens[i] as number,
      partial: false,
    };
    if (part.kind === "tool_use") {
      const parsed = parseJson(part.json ?? "");
      return {
        ...base,
        kind: "tool_use",
        name: part.name ?? "tool",
        input: parsed.value,
        inputRaw: parsed.raw,
        callKey: part.callKey ?? null,
        verdict: null,
        partial: parsed.raw,
      } satisfies ToolUseBlock;
    }
    if (part.kind === "thinking") {
      return {
        ...base,
        kind: "thinking",
        text: part.text ?? "",
        seconds: null,
      };
    }
    return { ...base, kind: "text", text: part.text ?? "" };
  });
  return {
    version: MESSAGE_ASSEMBLY_VERSION,
    blocks,
    stopReason,
    ttftMs: timing.ttftMs ?? null,
    durationMs: timing.durationMs ?? null,
    usage,
    partial: blocks.some((block) => block.partial),
    // A non-streamed document arrived as one response, so it counts as one
    // event: `wire.events` says how many SSE envelopes were folded, and a
    // document folds in a single pass.
    wire: { events: 1, bytes: Buffer.byteLength(wire, "utf8") },
  };
}

/** Anthropic Messages, not streamed: the whole `content` array in one document. */
function assembleAnthropicMessageDoc(
  root: Record<string, unknown>,
  timing: AssemblyTiming,
  wire: string,
): MessageAssembly | null {
  const content = root["content"];
  if (!Array.isArray(content)) return null;
  const parts: NonStreamedPart[] = [];
  for (const raw of content) {
    const item = asRecord(raw);
    if (item === null) continue;
    const kind = blockKindOf(str(item, "type"));
    if (kind === "tool_use") {
      const input = item["input"];
      parts.push({
        kind: "tool_use",
        json: input === undefined ? "" : JSON.stringify(input),
        name: str(item, "name"),
        callKey: str(item, "id"),
      });
      continue;
    }
    // A model's own message carries no `tool_result` block; one would only
    // appear in a request the caller sent back, which is not this shape.
    if (kind === "tool_result") continue;
    const text = str(item, "text") ?? str(item, "thinking");
    if (text === null) continue;
    parts.push({ kind, text });
  }
  const usage = asRecord(root["usage"]);
  const assemblyUsage: AssemblyUsage = {
    inputTokens: num(usage, "input_tokens"),
    cacheReadTokens: num(usage, "cache_read_input_tokens"),
    cacheWriteTokens: num(usage, "cache_creation_input_tokens"),
    outputTokens: num(usage, "output_tokens"),
  };
  return finishNonStreamed(
    parts,
    str(root, "stop_reason"),
    assemblyUsage,
    timing,
    wire,
  );
}

/** OpenAI Responses, not streamed: the whole `output` array in one document. */
function assembleOpenAiResponseDoc(
  root: Record<string, unknown>,
  timing: AssemblyTiming,
  wire: string,
): MessageAssembly | null {
  const output = root["output"];
  if (!Array.isArray(output)) return null;
  const parts: NonStreamedPart[] = [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (item === null) continue;
    if (item["type"] === "function_call") {
      const args = item["arguments"];
      parts.push({
        kind: "tool_use",
        json: typeof args === "string" ? args : "",
        name: str(item, "name"),
        callKey: str(item, "call_id"),
      });
      continue;
    }
    const reasoning = item["type"] === "reasoning";
    const pieces = reasoning ? item["summary"] : item["content"];
    if (!Array.isArray(pieces)) continue;
    for (const rawPiece of pieces) {
      const piece = asRecord(rawPiece);
      const text = str(piece, "text") ?? str(piece, "refusal");
      if (text === null) continue;
      parts.push({ kind: reasoning ? "thinking" : "text", text });
    }
  }
  const usage = asRecord(root["usage"]);
  const cached = num(
    asRecord(usage?.["input_tokens_details"]),
    "cached_tokens",
  );
  const input = num(usage, "input_tokens");
  const assemblyUsage: AssemblyUsage = {
    inputTokens: input === null ? null : input - (cached ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    outputTokens: num(usage, "output_tokens"),
  };
  const stopReason =
    str(asRecord(root["incomplete_details"]), "reason") ?? str(root, "status");
  return finishNonStreamed(parts, stopReason, assemblyUsage, timing, wire);
}

/** OpenAI Chat Completions, not streamed: `choices[0].message`. */
function assembleChatCompletionDoc(
  root: Record<string, unknown>,
  timing: AssemblyTiming,
  wire: string,
): MessageAssembly | null {
  const choices = root["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.["message"]);
  if (message === null) return null;
  const parts: NonStreamedPart[] = [];
  const content = message["content"];
  if (typeof content === "string" && content.length > 0) {
    parts.push({ kind: "text", text: content });
  }
  const toolCalls = message["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const raw of toolCalls) {
      const call = asRecord(raw);
      const fn = asRecord(call?.["function"]);
      parts.push({
        kind: "tool_use",
        json: str(fn, "arguments") ?? "",
        name: str(fn, "name"),
        callKey: str(call, "id"),
      });
    }
  }
  const usage = asRecord(root["usage"]);
  const cached = num(
    asRecord(usage?.["prompt_tokens_details"]),
    "cached_tokens",
  );
  const prompt = num(usage, "prompt_tokens");
  const assemblyUsage: AssemblyUsage = {
    inputTokens: prompt === null ? null : prompt - (cached ?? 0),
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    outputTokens: num(usage, "completion_tokens"),
  };
  return finishNonStreamed(
    parts,
    str(choice, "finish_reason"),
    assemblyUsage,
    timing,
    wire,
  );
}

/**
 * Fold a response that was never streamed: one JSON document, in any of the
 * three shapes `assembleSseStream` reads incrementally above. A harness may
 * ask with `stream: false`, which every vendor here honors, and the bytes
 * that come back are the whole message at once rather than deltas, so this
 * reads the document's arrays directly rather than through the block/delta
 * machinery above, which exists for a stream that has no array to read yet.
 */
function assembleNonStreamedDocument(
  wire: string,
  timing: AssemblyTiming,
): MessageAssembly | null {
  const trimmed = responseWire(wire).trim();
  if (!trimmed.startsWith("{")) return null;
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
  if (root === null) return null;
  if (str(root, "type") === "message" && Array.isArray(root["content"])) {
    return assembleAnthropicMessageDoc(root, timing, trimmed);
  }
  if (str(root, "object") === "response" && Array.isArray(root["output"])) {
    return assembleOpenAiResponseDoc(root, timing, trimmed);
  }
  if (Array.isArray(root["choices"])) {
    return assembleChatCompletionDoc(root, timing, trimmed);
  }
  return null;
}

/** The stored assembly as JSON bytes, for the object written beside the wire. */
export function encodeAssembly(assembly: MessageAssembly): Uint8Array {
  return Buffer.from(JSON.stringify(assembly), "utf8");
}

/**
 * A stored assembly read back, or null when the bytes are not one this
 * module's current version wrote. A stale version is recomputed rather than
 * shown, so a fold that improves reaches every run and not only new ones.
 */
export function decodeAssembly(bytes: Uint8Array): MessageAssembly | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    const record = asRecord(parsed);
    if (record === null) return null;
    if (record.version !== MESSAGE_ASSEMBLY_VERSION) return null;
    if (!Array.isArray(record.blocks)) return null;
    return record as unknown as MessageAssembly;
  } catch {
    return null;
  }
}
