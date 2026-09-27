// body.ts: read an upstream response inside the call's deadline, and turn a
// Transport failure into a SendError.
//
// A response body arrives in chunks. Each read races the call's clock, so a
// slow or endless body ends at the deadline or on cancel, and the Transport
// is told to stop. A body over the cap ends the read too, so one call cannot
// hold unbounded memory.
import { MAX_RESULT_BYTES_LIMIT } from "../contract/tools";
import { stopError, type Clock } from "./retry";
import type { SendError } from "./sender";
import { TransportError, type HttpTransportResponse, type TransportErrorCode } from "./transport";
import { messageOf } from "./util";

/**
 * The most bytes one response body may hold. select and redact run after the
 * Sender and can shrink a result, so the cap sits well above the largest
 * max_result_bytes a tool can set.
 */
export const MAX_BODY_BYTES = 16 * MAX_RESULT_BYTES_LIMIT;

const TRANSPORT_TITLES: Record<TransportErrorCode, string> = {
  refused_address: "Address refused",
  refused_redirect: "Redirect refused",
  refused_host: "Host refused",
  unsupported: "Unsupported transport",
  disconnected: "Not connected",
  timeout: "Deadline exceeded",
  not_sent: "Not sent",
};

/** A Transport failure as a SendError, and whether the upstream may have received the request. */
export function transportFailure(error: unknown): { error: SendError; sent: boolean } {
  if (error instanceof TransportError) {
    return {
      error: { title: TRANSPORT_TITLES[error.code], detail: error.message, status: undefined },
      sent: error.sent,
    };
  }
  // A Transport that throws anything else may have sent the request.
  return { error: { title: "Transport error", detail: messageOf(error), status: undefined }, sent: true };
}

export type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; error: SendError };

export interface ReadOptions {
  clock: Clock;
  /** The call's deadline_ms, for the error text. */
  deadline_ms: number;
  /** The most bytes to read. MAX_BODY_BYTES by default. */
  limit?: number;
}

/**
 * Read the body chunk by chunk. onChunk returns true when it has what it
 * needs, which ends the read early. The response is cancelled whenever the
 * read ends before the body does.
 */
export async function readChunks(
  response: HttpTransportResponse,
  options: ReadOptions,
  onChunk: (chunk: Uint8Array) => boolean,
): Promise<{ ok: true } | { ok: false; error: SendError }> {
  const limit = options.limit ?? MAX_BODY_BYTES;
  let chunks: AsyncIterator<Uint8Array>;
  try {
    chunks = response.body[Symbol.asyncIterator]();
  } catch (error) {
    response.cancel();
    return { ok: false, error: transportFailure(error).error };
  }
  let total = 0;
  for (;;) {
    const next = await options.clock.race(chunks.next());
    if (next.kind === "stopped") {
      response.cancel();
      return { ok: false, error: stopError(next.stop, options.deadline_ms) };
    }
    if (next.kind === "failed") {
      response.cancel();
      return { ok: false, error: transportFailure(next.error).error };
    }
    if (next.value.done === true) return { ok: true };
    const chunk = next.value.value;
    total += chunk.byteLength;
    if (total > limit) {
      response.cancel();
      return {
        ok: false,
        error: {
          title: "Response too large",
          detail: `The upstream's response passed ${limit} bytes, the most one call reads.`,
          status: response.status,
        },
      };
    }
    if (onChunk(chunk)) {
      response.cancel();
      return { ok: true };
    }
  }
}

/** Read the whole body, up to the cap. */
export async function readBody(response: HttpTransportResponse, options: ReadOptions): Promise<BodyRead> {
  const chunks: Uint8Array[] = [];
  const read = await readChunks(response, options, (chunk) => {
    chunks.push(chunk);
    return false;
  });
  if (!read.ok) return read;
  return { ok: true, bytes: concat(chunks) };
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** UTF-8 text. A byte order mark is dropped, and a bad sequence becomes U+FFFD. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The parsed JSON, or the parser's message. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/** True for a JSON media type: application/json or any +json type, with or without parameters. */
export function isJsonMediaType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const semicolon = contentType.indexOf(";");
  const type = (semicolon === -1 ? contentType : contentType.slice(0, semicolon)).trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

/** One server-sent event. */
export interface SseEvent {
  event: string;
  data: string;
}

/**
 * An incremental text/event-stream parser (WHATWG HTML, Server-sent events).
 * push() takes decoded text as it arrives and returns every event it
 * completes. Comments, ids, and retry fields are read and dropped.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      // A lone \r at the end may be the first half of \r\n, so wait for more.
      if (match === null || (match[0] === "\r" && match.index === this.buffer.length - 1)) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /** The end of the stream. An event with no blank line after it is dropped, as the standard says. */
  end(): SseEvent[] {
    const events = this.push("");
    // push() held back a trailing \r in case \n followed. At the end of the stream it ends a line.
    if (this.buffer.endsWith("\r")) {
      const event = this.line(this.buffer.slice(0, -1));
      if (event !== undefined) events.push(event);
    }
    this.buffer = "";
    this.event = "";
    this.data = [];
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return undefined;
      }
      const event = { event: this.event === "" ? "message" : this.event, data: this.data.join("\n") };
      this.event = "";
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }
}
