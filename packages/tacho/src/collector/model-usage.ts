/**
 * Observed metering for the loopback model proxy (story sheet item 10).
 *
 * The proxy tees every response past a `UsageMeter`. The meter reads the
 * vendor's own usage block out of the bytes going by and keeps nothing else:
 * no prompt, no completion, no tool input. What it holds at any moment is one
 * partial line of a stream, or the prefix of one JSON document, and both are
 * dropped the moment they have been read.
 *
 * Four response shapes carry usage, and each is read where the vendor puts it:
 *
 *   - Anthropic Messages, not streamed: the document's `usage`.
 *   - Anthropic Messages, streamed: `message_start.message.usage` opens the
 *     count and every `message_delta.usage` replaces the members it names.
 *     `output_tokens` there is cumulative, so the last delta seen is the count
 *     even when the stream is cut short.
 *   - OpenAI Responses: `response.completed` (and the `incomplete` and
 *     `failed` endings) carry `response.usage`. Not streamed, the document's
 *     `usage`.
 *   - OpenAI Chat Completions: the document's `usage`, or the one chunk that
 *     carries a non-null `usage`, which the vendor only sends when the caller
 *     asked with `stream_options.include_usage`. A stream without it reports
 *     no usage at all, and the frame says so rather than guessing.
 *
 * A stream can also stop before the event that closes its count: the caller
 * left, the operator interrupted it, or the connection reset. The meter
 * counts the bytes of text the content deltas carried, without parsing them,
 * so `estimateCutUsage` can complete such a count by estimate. A vendor
 * error that ends a stream after its `200` is kept as `streamError`.
 *
 * Token classes are normalised to the envelope's columns, which follow
 * Anthropic's convention: `input_tokens` is the uncached input, and cache
 * reads and cache writes are counted beside it. OpenAI reports an inclusive
 * input figure, so its cached tokens are moved out of it.
 */
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
} from "node:zlib";
import type { Transform } from "node:stream";

export type ModelProvider = "anthropic" | "openai";

/** Which response shape a route answers with. */
export type ModelApi =
  | "anthropic.messages"
  | "openai.responses"
  | "openai.chat"
  | "other";

export interface ObservedUsage {
  model?: string;
  /** The vendor's id for the response (`msg_…`, `resp_…`, `chatcmpl-…`). */
  responseId?: string;
  stopReason?: string;
  serviceTier?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheCreation5mTokens?: number;
  cacheCreation1hTokens?: number;
  thinkingTokens?: number;
  /**
   * The error a stream ended on after its `200`: Anthropic's `event: error`,
   * a Responses `error` event, or `response.failed`. The vendor's own error
   * type or code, reduced to a short slug.
   */
  streamError?: string;
}

/** Whether a usage block said anything about tokens at all. */
export function hasTokenCounts(usage: ObservedUsage): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheCreationTokens !== undefined
  );
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 512)
    : undefined;
}

function assign<K extends keyof ObservedUsage>(
  into: ObservedUsage,
  key: K,
  value: ObservedUsage[K] | undefined,
): void {
  if (value !== undefined) into[key] = value;
}

/** Fold an Anthropic `usage` block into the running count. */
function foldAnthropicUsage(into: ObservedUsage, usage: Json): void {
  assign(into, "inputTokens", count(usage["input_tokens"]));
  assign(into, "outputTokens", count(usage["output_tokens"]));
  assign(into, "cacheReadTokens", count(usage["cache_read_input_tokens"]));
  assign(
    into,
    "cacheCreationTokens",
    count(usage["cache_creation_input_tokens"]),
  );
  const creation = obj(usage["cache_creation"]);
  if (creation !== undefined) {
    assign(
      into,
      "cacheCreation5mTokens",
      count(creation["ephemeral_5m_input_tokens"]),
    );
    assign(
      into,
      "cacheCreation1hTokens",
      count(creation["ephemeral_1h_input_tokens"]),
    );
  }
  assign(into, "serviceTier", text(usage["service_tier"]));
}

/**
 * Fold an OpenAI usage block, Responses or Chat Completions. Both report an
 * inclusive input figure with the cached part named beside it.
 */
function foldOpenAiUsage(into: ObservedUsage, usage: Json): void {
  const input = count(usage["input_tokens"]) ?? count(usage["prompt_tokens"]);
  const output =
    count(usage["output_tokens"]) ?? count(usage["completion_tokens"]);
  const inputDetails =
    obj(usage["input_tokens_details"]) ?? obj(usage["prompt_tokens_details"]);
  const outputDetails =
    obj(usage["output_tokens_details"]) ??
    obj(usage["completion_tokens_details"]);
  const cached = count(inputDetails?.["cached_tokens"]);
  if (input !== undefined)
    into.inputTokens = Math.max(0, input - (cached ?? 0));
  assign(into, "outputTokens", output);
  assign(into, "cacheReadTokens", cached);
  assign(into, "thinkingTokens", count(outputDetails?.["reasoning_tokens"]));
}

/** A vendor's error type or code as a short slug for `api_error_class`. */
function errorKind(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 64)
    : undefined;
}

/** The Responses stream events that end a response, each with its usage. */
const RESPONSES_ENDINGS = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/**
 * Read one parsed document or stream event into the running count. Returns
 * whether it ended the response: it carried the vendor's closing count, or
 * it was the error the vendor ended the stream on instead. A stream that
 * stops before one was cut short (`UsageMeter.cutShort`).
 */
export function foldUsageDocument(
  into: ObservedUsage,
  api: ModelApi,
  doc: unknown,
): boolean {
  const root = obj(doc);
  if (root === undefined) return false;
  if (api === "anthropic.messages") {
    const type = root["type"];
    if (type === "error") {
      into.streamError = errorKind(obj(root["error"])?.["type"]) ?? "error";
      return true;
    }
    if (type === "message_start") {
      const message = obj(root["message"]);
      if (message === undefined) return false;
      assign(into, "model", text(message["model"]));
      assign(into, "responseId", text(message["id"]));
      const usage = obj(message["usage"]);
      if (usage !== undefined) foldAnthropicUsage(into, usage);
      return false;
    }
    if (type === "message_delta") {
      const usage = obj(root["usage"]);
      if (usage !== undefined) foldAnthropicUsage(into, usage);
      assign(into, "stopReason", text(obj(root["delta"])?.["stop_reason"]));
      return true;
    }
    if (type === "message" || type === undefined) {
      assign(into, "model", text(root["model"]));
      assign(into, "responseId", text(root["id"]));
      assign(into, "stopReason", text(root["stop_reason"]));
      const usage = obj(root["usage"]);
      if (usage !== undefined) foldAnthropicUsage(into, usage);
      return true;
    }
    return false;
  }
  if (api === "openai.responses") {
    const type = root["type"];
    if (type === "error") {
      const error = obj(root["error"]);
      into.streamError =
        errorKind(root["code"]) ??
        errorKind(error?.["code"]) ??
        errorKind(error?.["type"]) ??
        "error";
      return true;
    }
    // Streamed endings wrap the response. The unstreamed document is it.
    // Status, model and id are read whether or not a usage block came with
    // them: `response.failed` ends a stream with `usage: null`, and its
    // status is the only thing that says the call failed.
    const response = obj(root["response"]) ?? root;
    assign(into, "model", text(response["model"]));
    assign(into, "responseId", text(response["id"]));
    assign(into, "stopReason", text(response["status"]));
    assign(into, "serviceTier", text(response["service_tier"]));
    if (type === "response.failed")
      into.streamError =
        errorKind(obj(response["error"])?.["code"]) ?? "response_failed";
    const usage = obj(response["usage"]);
    if (usage !== undefined) foldOpenAiUsage(into, usage);
    return typeof type === "string"
      ? RESPONSES_ENDINGS.has(type)
      : usage !== undefined;
  }
  if (api === "openai.chat") {
    const usage = obj(root["usage"]);
    if (usage === undefined) return false;
    foldOpenAiUsage(into, usage);
    assign(into, "model", text(root["model"]));
    assign(into, "responseId", text(root["id"]));
    assign(into, "serviceTier", text(root["service_tier"]));
    return true;
  }
  return false;
}

/**
 * The longest stream line the meter will hold before it gives up on finding
 * usage in it; a longer one is skipped. Matches `MAX_DOCUMENT_BYTES`: a
 * `response.completed` line can carry the whole response's `output`
 * alongside its usage block, so the same-sized prompt that would not have
 * dropped an unstreamed document's usage must not drop a streamed one's
 * either, just because the vendor's ending happened to be one SSE line.
 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The largest unstreamed document the meter will parse for usage. */
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;

const USAGE_MARKER = Buffer.from('"usage"');
/** The two stream events that end a response in an error, not a count. */
const ERROR_MARKERS = [
  Buffer.from('"type":"error"'),
  Buffer.from('"response.failed"'),
];
const DATA_PREFIX = Buffer.from("data:");
const DONE_MARKER = Buffer.from("[DONE]");

/**
 * Where each API's content deltas carry their text. The meter measures that
 * text and does not parse it, so a stream cut before its count still says
 * roughly how much it had carried.
 */
const DELTA_MARKERS: Record<ModelApi, readonly Buffer[]> = {
  "anthropic.messages": ['"text":"', '"partial_json":"', '"thinking":"'].map(
    (marker) => Buffer.from(marker),
  ),
  "openai.responses": [Buffer.from('"delta":"')],
  "openai.chat": ['"content":"', '"arguments":"'].map((marker) =>
    Buffer.from(marker),
  ),
  other: [],
};

/** The bytes of the JSON string that starts at `from`, up to its closing quote. */
function stringBytes(line: Buffer, from: number): number {
  for (let at = from; at < line.length; at += 1) {
    const byte = line[at];
    if (byte === 0x5c /* \ */) at += 1;
    else if (byte === 0x22 /* " */) return at - from;
  }
  return line.length - from;
}

/** Output bytes per token, for a stream cut before the vendor counted it. */
const BYTES_PER_TOKEN = 4;

/**
 * The usage of a stream that was cut short, completed by estimate. The
 * output is at least the text the stream carried, at four bytes a token,
 * because the count a vendor opens with (Anthropic's `output_tokens: 1`) says
 * nothing about what followed it. The input is estimated from the request's
 * decoded bytes only when the vendor said nothing about tokens at all, which
 * is every cut OpenAI stream.
 */
export function estimateCutUsage(
  usage: ObservedUsage,
  contentBytes: number,
  requestBytes: number,
): ObservedUsage {
  return {
    ...usage,
    outputTokens: Math.max(
      usage.outputTokens ?? 0,
      Math.ceil(contentBytes / BYTES_PER_TOKEN),
    ),
    ...(hasTokenCounts(usage)
      ? {}
      : { inputTokens: Math.ceil(requestBytes / BYTES_PER_TOKEN) }),
  };
}

/**
 * Reads usage out of a response as its bytes go by. `write` is called with
 * each decoded chunk. `end` returns what was seen. Safe to abandon half way:
 * a stream that is cut short reports whatever the vendor had said by then.
 */
export class UsageMeter {
  private readonly api: ModelApi;
  private streaming: boolean;
  private sniffed: boolean;
  private readonly usage: ObservedUsage = {};
  private line: Buffer[] = [];
  private lineBytes = 0;
  private lineOverflow = false;
  private document: Buffer[] = [];
  private documentBytes = 0;
  private documentOverflow = false;
  private ended = false;
  private deltaBytes = 0;

  constructor(api: ModelApi, contentType: string | undefined) {
    this.api = api;
    this.streaming = (contentType ?? "").includes("text/event-stream");
    this.sniffed = this.streaming;
  }

  /**
   * A stream is known by its content type, or failing that by how it starts.
   * The ChatGPT Codex backend streams `/responses` without declaring
   * `text/event-stream`, and a meter that trusted the header alone recorded
   * those calls with no usage.
   */
  private sniff(chunk: Buffer): void {
    this.sniffed = true;
    const head = chunk.subarray(0, 64).toString("latin1").trimStart();
    if (/^(event|data|id|retry)?:/.test(head)) this.streaming = true;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  /**
   * Whether a stream stopped before its ending: the event carrying the
   * vendor's closing count, the error that replaced it, or a chat stream's
   * `[DONE]`. Its usage then undercounts, and `estimateCutUsage` completes it
   * from `contentBytes`. Read it after `end`.
   */
  get cutShort(): boolean {
    return this.api !== "other" && this.streaming && !this.ended;
  }

  /** The text the stream's content deltas carried, in bytes as sent. */
  get contentBytes(): number {
    return this.deltaBytes;
  }

  write(chunk: Buffer): void {
    if (this.api === "other") return;
    if (!this.sniffed && chunk.length > 0) this.sniff(chunk);
    if (!this.streaming) {
      if (this.documentOverflow) return;
      this.documentBytes += chunk.length;
      if (this.documentBytes > MAX_DOCUMENT_BYTES) {
        this.documentOverflow = true;
        this.document = [];
        return;
      }
      this.document.push(chunk);
      return;
    }
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this.holdLine(chunk.subarray(start));
        return;
      }
      this.holdLine(chunk.subarray(start, newline));
      this.finishLine();
      start = newline + 1;
    }
  }

  private holdLine(part: Buffer): void {
    if (part.length === 0 || this.lineOverflow) return;
    this.lineBytes += part.length;
    if (this.lineBytes > MAX_LINE_BYTES) {
      this.lineOverflow = true;
      this.line = [];
      return;
    }
    this.line.push(part);
  }

  private finishLine(): void {
    const overflow = this.lineOverflow;
    const line =
      this.line.length === 1 ? this.line[0] : Buffer.concat(this.line);
    this.line = [];
    this.lineBytes = 0;
    this.lineOverflow = false;
    if (overflow || line === undefined) return;
    // Only a `data:` line that mentions usage or an error is parsed at all.
    // Content deltas are the bulk of a stream and none of them is parsed:
    // the text they carry is measured where it starts, and nothing more.
    if (line.length < 6 || line[0] !== 0x64 /* d */) return;
    if (!line.subarray(0, 5).equals(DATA_PREFIX)) return;
    for (const marker of DELTA_MARKERS[this.api]) {
      const at = line.indexOf(marker);
      if (at !== -1) this.deltaBytes += stringBytes(line, at + marker.length);
    }
    if (
      line.indexOf(USAGE_MARKER) === -1 &&
      !ERROR_MARKERS.some((marker) => line.indexOf(marker) !== -1)
    ) {
      if (line.length <= 16 && line.indexOf(DONE_MARKER) !== -1)
        this.ended = true;
      return;
    }
    try {
      if (
        foldUsageDocument(
          this.usage,
          this.api,
          JSON.parse(line.subarray(5).toString("utf8")),
        )
      )
        this.ended = true;
    } catch {
      // A line that is not JSON says nothing about usage.
    }
  }

  end(): ObservedUsage {
    if (this.api !== "other") {
      if (this.streaming) {
        if (this.lineBytes > 0) this.finishLine();
      } else if (!this.documentOverflow && this.documentBytes > 0) {
        const bytes = Buffer.concat(this.document);
        this.document = [];
        if (bytes.indexOf(USAGE_MARKER) !== -1) {
          try {
            foldUsageDocument(
              this.usage,
              this.api,
              JSON.parse(bytes.toString("utf8")),
            );
          } catch {
            // An error page or a truncated body carries no usage.
          }
        }
      }
    }
    this.document = [];
    this.line = [];
    return { ...this.usage };
  }
}

/**
 * A decoder for a response the upstream compressed anyway. The proxy asks for
 * `identity`, so this is the exception: a vendor edge that ignores the request
 * still gets its bytes passed through untouched, and the meter reads a decoded
 * copy. An encoding nobody here can decode returns undefined, and the call is
 * recorded without usage.
 */
export function decoderFor(
  encoding: string | undefined,
): Transform | undefined {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "gzip" || name === "x-gzip") return createGunzip();
  if (name === "br") return createBrotliDecompress();
  if (name === "deflate") return createInflate();
  if (name === "zstd") return createZstdDecompress();
  return undefined;
}
