// sink.ts: where an upstream call sends its response, as frames to the broker.
//
// A call's response goes out as a head, then data, then one terminal frame:
// end for HTTP, trailers for gRPC, or fail. The sink sends exactly one
// terminal frame and nothing after it. It checks every frame against the
// limits the broker accepts, so an upstream that answers with more than the
// protocol can carry ends the call with a fail instead of a frame the broker
// would drop.
//
// The sink also enforces the response cap and slows the upstream down while
// the connection to the broker has too much queued.
import {
  MAX_FRAME_BYTES,
  toBase64,
  type RelayFailureCode,
  type RelayFrame,
} from "@oxagen/relay-broker/protocol";
import type { HeaderEntry } from "./credentials";

/** Stop reading the upstream while this many bytes wait on the connection. */
export const BUFFER_HIGH_WATER = 1024 * 1024;
/** Read the upstream again once the queue falls to this. */
export const BUFFER_LOW_WATER = 256 * 1024;
const DRAIN_POLL_MS = 10;

/** The largest gRPC message one data frame can carry once it is base64. */
export const MAX_GRPC_MESSAGE_BYTES = Math.floor((MAX_FRAME_BYTES - 1024) / 4) * 3;

// The limits the broker's frame schema sets.
const MAX_HEADER_ENTRIES = 1024;
const MAX_HEADER_NAME = 256;
const MAX_HEADER_VALUE = 65_536;
const MAX_FAIL_MESSAGE = 2048;
const MAX_TRAILERS_MESSAGE = 4096;
/** gRPC status 2, UNKNOWN, for a code outside 0 to 16. */
const GRPC_UNKNOWN = 2;

export interface ResponseSink {
  /** True once the call has ended, by a terminal frame or by close(). */
  readonly closed: boolean;
  head(status: number, headers: readonly HeaderEntry[]): void;
  /**
   * Send one HTTP body part or one gRPC message. Resolves true when the
   * upstream may send more, and false when the call is over.
   */
  data(chunk: Uint8Array): Promise<boolean>;
  end(): void;
  trailers(code: number, message: string, metadata: readonly HeaderEntry[]): void;
  fail(code: RelayFailureCode, message: string, sent: boolean): void;
}

export interface FrameSinkOptions {
  id: string;
  send(frame: RelayFrame): void;
  /** The bytes queued on the connection to the broker. */
  buffered(): number;
  maxResponseBytes: number;
  /** Runs once, when the call ends. */
  onDone(): void;
}

/** A message cut to the length the broker accepts, never through the middle of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 3;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}...`;
}

function headersFit(headers: readonly HeaderEntry[]): boolean {
  if (headers.length > MAX_HEADER_ENTRIES) return false;
  return headers.every(
    ([name, value]) => name.length >= 1 && name.length <= MAX_HEADER_NAME && value.length <= MAX_HEADER_VALUE,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FrameSink implements ResponseSink {
  private done = false;
  private headSent = false;
  private bytes = 0;

  constructor(private readonly options: FrameSinkOptions) {}

  get closed(): boolean {
    return this.done;
  }

  head(status: number, headers: readonly HeaderEntry[]): void {
    if (this.done || this.headSent) return;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      this.fail("upstream", `The upstream answered with status ${status}, which is not an HTTP status.`, true);
      return;
    }
    if (!headersFit(headers)) {
      this.fail("too_large", "The upstream's response headers are larger than the relay can carry.", true);
      return;
    }
    this.headSent = true;
    this.options.send({ type: "head", id: this.options.id, status, headers: [...headers] });
  }

  async data(chunk: Uint8Array): Promise<boolean> {
    if (this.done) return false;
    if (!this.headSent) {
      this.fail("upstream", "The upstream sent a body before its response head.", true);
      return false;
    }
    this.bytes += chunk.byteLength;
    if (this.bytes > this.options.maxResponseBytes) {
      this.fail(
        "too_large",
        `The response passed the relay's cap of ${this.options.maxResponseBytes} bytes (RELAY_MAX_RESPONSE_BYTES).`,
        true,
      );
      return false;
    }
    this.options.send({ type: "data", id: this.options.id, chunk: toBase64(chunk) });
    if (this.options.buffered() > BUFFER_HIGH_WATER) {
      while (!this.done && this.options.buffered() > BUFFER_LOW_WATER) await sleep(DRAIN_POLL_MS);
    }
    return !this.done;
  }

  end(): void {
    if (this.done) return;
    if (!this.headSent) {
      this.fail("upstream", "The upstream ended the response before its head.", true);
      return;
    }
    this.finish({ type: "end", id: this.options.id });
  }

  trailers(code: number, message: string, metadata: readonly HeaderEntry[]): void {
    if (this.done) return;
    if (!headersFit(metadata)) {
      this.fail("too_large", "The upstream's gRPC trailers are larger than the relay can carry.", true);
      return;
    }
    if (!this.headSent) this.head(200, []);
    const status = Number.isInteger(code) && code >= 0 && code <= 16 ? code : GRPC_UNKNOWN;
    this.finish({
      type: "trailers",
      id: this.options.id,
      code: status,
      message: clip(message, MAX_TRAILERS_MESSAGE),
      metadata: [...metadata],
    });
  }

  fail(code: RelayFailureCode, message: string, sent: boolean): void {
    if (this.done) return;
    this.finish({ type: "fail", id: this.options.id, code, message: clip(message, MAX_FAIL_MESSAGE), sent });
  }

  /** End the call without a frame, as when the broker cancelled it or the connection closed. */
  close(): void {
    if (this.done) return;
    this.done = true;
    this.options.onDone();
  }

  private finish(frame: RelayFrame): void {
    this.done = true;
    this.options.send(frame);
    this.options.onDone();
  }
}
