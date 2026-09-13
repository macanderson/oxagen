// Server-Sent Events over a run_seq cursor (plan §4.9).
//
// The run ledger's read is resumable on a decimal `run_seq`
// (`readAttemptEventsSince(runId, afterRunSeq, limit)`), which maps directly
// onto SSE's `id:` / `Last-Event-ID`: every event carries its seq as its id, and
// a reconnecting EventSource sends the last one back, so the stream resumes
// exactly after the last event the browser saw.
//
// Delivery is at-least-once (spec §15). The server never sends a seq at or
// below its cursor, and the client hooks dedupe by seq as well.
//
// Pure of Next and of any store: the route hands in a `read` function, so every
// branch here has a unit test.
import type { ReadFailure } from "@/data/not-backed";
import { InvalidStreamCursor } from "./errors";
import { compareSeq, isStreamSeq } from "./stream-seq";

export { compareSeq, isStreamSeq };

/**
 * The cursor a stream resumes after: `Last-Event-ID` (a reconnect) wins over
 * `?after=` (the first connect, seeded from server-rendered data), else "0".
 * An empty `Last-Event-ID` is what a browser sends before any event had an id.
 */
export function resolveStreamCursor(
  lastEventId: string | null,
  after: string | null,
): string {
  const raw =
    lastEventId !== null && lastEventId !== "" ? lastEventId : (after ?? "0");
  if (!isStreamSeq(raw)) throw new InvalidStreamCursor(raw);
  return raw;
}

export type StreamItem = { readonly seq: string };

export type StreamRead<T extends StreamItem> = (
  afterSeq: string,
) => Promise<{ ok: true; value: readonly T[] } | ReadFailure>;

export type CursorStreamOptions<T extends StreamItem> = {
  read: StreamRead<T>;
  /** Exclusive: only items with a seq above it are sent. */
  cursor: string;
  signal: AbortSignal;
  /** The SSE event name for an item (`frame` for a run, `patch` for the fleet). */
  event: string;
  /** Wait between reads that returned nothing. */
  pollMs?: number;
  /** Send a comment at least this often so proxies keep an idle stream open. */
  keepAliveMs?: number;
  /**
   * Close after this long; the browser reconnects with Last-Event-ID. Bounds
   * how long one request holds a server worker and a pooled connection.
   */
  maxDurationMs?: number;
  /** The reconnect delay advertised to EventSource. */
  retryMs?: number;
  /** Called with a read that threw; the stream then sends an error state and closes. */
  onError?: (error: unknown) => void | Promise<void>;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type StreamTimings = {
  pollMs: number;
  keepAliveMs: number;
  maxDurationMs: number;
  retryMs: number;
};

export const STREAM_DEFAULTS: Readonly<StreamTimings> = {
  pollMs: 1000,
  keepAliveMs: 15_000,
  maxDurationMs: 5 * 60_000,
  retryMs: 3000,
};

/** The state sent when a read throws: the page renders it like any failed read. */
export const STREAM_READ_FAILED: ReadFailure = {
  ok: false,
  reason: "error",
  code: "stream_read_failed",
  status: 503,
};

export function encodeSseEvent(input: {
  event: string;
  data: unknown;
  id?: string;
}): string {
  const id = input.id === undefined ? "" : `id: ${input.id}\n`;
  // JSON.stringify never emits a raw newline, so one data line is always valid.
  return `${id}event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`;
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createCursorStream<T extends StreamItem>(
  options: CursorStreamOptions<T>,
): ReadableStream<Uint8Array> {
  const {
    read,
    signal,
    event,
    onError,
    pollMs = STREAM_DEFAULTS.pollMs,
    keepAliveMs = STREAM_DEFAULTS.keepAliveMs,
    maxDurationMs = STREAM_DEFAULTS.maxDurationMs,
    retryMs = STREAM_DEFAULTS.retryMs,
    now = Date.now,
    sleep = abortableSleep,
  } = options;
  const encoder = new TextEncoder();
  const startedAt = now();
  let cursor = options.cursor;
  let lastWriteAt = startedAt;
  // An object, not a `let`: abort and cancel flip it while `read` is awaited.
  const life = { closed: false };
  const isClosed = () => life.closed;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${String(retryMs)}\n\n`));
      const onAbort = () => {
        if (life.closed) return;
        life.closed = true;
        controller.close();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    },

    // One pull runs until it has enqueued something or closed the stream. A
    // pull that resolves without enqueuing is never called again while the
    // consumer's read is already pending, so an idle poll must loop here.
    async pull(controller) {
      const send = (chunk: string) => {
        if (life.closed) return;
        controller.enqueue(encoder.encode(chunk));
        lastWriteAt = now();
      };
      const finish = () => {
        if (life.closed) return;
        life.closed = true;
        controller.close();
      };

      while (!life.closed) {
        if (now() - startedAt >= maxDurationMs) {
          finish();
          return;
        }

        let result: Awaited<ReturnType<StreamRead<T>>>;
        try {
          result = await read(cursor);
        } catch (error) {
          if (onError) {
            // Fire and forget: reporting must not delay or break the close.
            void Promise.resolve()
              .then(() => onError(error))
              .catch(() => undefined);
          }
          send(encodeSseEvent({ event: "state", data: STREAM_READ_FAILED }));
          finish();
          return;
        }
        if (isClosed()) return;

        if (!result.ok) {
          send(encodeSseEvent({ event: "state", data: result }));
          finish();
          return;
        }

        let sent = 0;
        for (const item of result.value) {
          if (!isStreamSeq(item.seq) || compareSeq(item.seq, cursor) <= 0)
            continue;
          cursor = item.seq;
          send(encodeSseEvent({ id: item.seq, event, data: item }));
          sent += 1;
        }
        if (sent > 0) return;

        const keepAlive = now() - lastWriteAt >= keepAliveMs;
        if (keepAlive) send(`: keep-alive\n\n`);
        await sleep(pollMs, signal);
        if (keepAlive) return;
      }
    },

    cancel() {
      life.closed = true;
    },
  });
}

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  // Nginx/Caddy-style buffering would hold events until the buffer fills.
  "x-accel-buffering": "no",
};
