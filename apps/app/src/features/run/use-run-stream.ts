"use client";
// Following a live run's head (spec §8.4's transport; the SSE route
// `GET /v1/:org/:ws/runs/:run_id/stream`).
//
// The stream carries frames. The transcript carries entries, which the
// contract derives from those frames on the server, so this hook does not turn
// one into the other: a frame arriving is the signal that there is more to
// read, and the player then asks `get_run_transcript` for the tail. Deriving
// an entry in the browser would put a second, weaker version of the contract's
// own derivation on the page, and the two would disagree.
//
// The browser reaches the route same-origin: `/api/v1/*` is rewritten to the
// Hono API in next.config.ts, so the session cookie travels and no second
// transport is introduced.
//
// A frame arrives per event, and a busy run writes many per second, so the
// signal is coalesced: the hook calls back once per `COALESCE_MS`, however
// many frames landed in that window.
import { useEffect, useRef, useState } from "react";

/** How long frames are gathered before the player is told to read the tail. */
const COALESCE_MS = 750;

/**
 * The first wait before reopening after `stream_unavailable`; each retry with
 * no frame between doubles it, and RETRY_LIMIT of them in a row is a loss.
 * Five retries wait 1, 2, 4, 8 and 16 seconds: a database timeout has cleared
 * well inside that, and a longer outage is one the page should name.
 */
const RETRY_BASE_MS = 1_000;
const RETRY_LIMIT = 5;

/** The codes that mean the viewer may no longer read this run. */
const DENIED_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "forbidden",
  "surface_denied",
  "pending_approval",
]);

export type StreamState =
  /** Not following: the run is not live, or the browser has no EventSource. */
  | "off"
  | "connecting"
  | "open"
  /** The run ended and the stream said so; nothing more will arrive. */
  | "sealed"
  /** The server refused further reads after access changed. */
  | "denied"
  /** The connection dropped and did not come back. The run kept recording. */
  | "lost";

/**
 * Follow one run's frames. `onFrames` fires at most once per COALESCE_MS,
 * after at least one frame has arrived.
 *
 * The route closes an idle stream with `event: done` and a cursor to resume
 * from; this reopens at that cursor, so a quiet run costs one reconnect every
 * few minutes rather than a connection held open past the platform's ceiling.
 */
export function useRunStream({
  url,
  enabled,
  onFrames,
}: {
  /** The stream route, without a cursor; the hook appends `?after=` when it resumes. */
  url: string;
  enabled: boolean;
  onFrames: () => void;
}): StreamState {
  const [state, setState] = useState<StreamState>(
    enabled ? "connecting" : "off",
  );
  // The callback is read through a ref so a new closure on every render does
  // not tear the stream down and build it again.
  const latest = useRef(onFrames);
  latest.current = onFrames;

  const deniedUrl = useRef<string | null>(null);

  useEffect(() => {
    if (deniedUrl.current === url) {
      setState("denied");
      return;
    }
    if (!enabled) {
      setState("off");
      return;
    }
    if (typeof EventSource === "undefined") {
      setState("off");
      return;
    }
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Retries since the last frame or clean close; progress resets it.
    let retries = 0;
    let stopped = false;

    function signal() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) latest.current();
      }, COALESCE_MS);
    }

    function flushSignal(force = false) {
      const pending = timer !== null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (!stopped && (pending || force)) latest.current();
    }

    function open(after: string | null) {
      if (stopped) return;
      const target =
        after === null ? url : `${url}?after=${encodeURIComponent(after)}`;
      const es = new EventSource(target, { withCredentials: true });
      source = es;
      let terminalError = false;
      es.onopen = () => {
        if (!stopped) setState("open");
      };
      es.onmessage = () => {
        retries = 0;
        signal();
      };
      es.addEventListener("done", (event: MessageEvent<string>) => {
        es.close();
        if (stopped) return;
        retries = 0;
        let reason = "idle";
        let cursor: string | null = null;
        try {
          const payload: unknown = JSON.parse(event.data);
          if (payload !== null && typeof payload === "object") {
            const done: Record<string, unknown> = { ...payload };
            if (typeof done.reason === "string") reason = done.reason;
            if (typeof done.cursor === "string") cursor = done.cursor;
          }
        } catch {
          // A malformed terminator is treated as an idle close: the run is not
          // known to have sealed, so the stream reopens rather than claiming
          // the recording ended.
        }
        // Whatever the reason, the tail is read once more: the last frames
        // arrived in the same batch as the terminator.
        flushSignal(true);
        if (reason === "sealed") {
          setState("sealed");
          return;
        }
        open(cursor);
      });
      es.addEventListener("error", (event: Event) => {
        if (stopped || !(event instanceof MessageEvent)) return;
        // A named server error. Native transport errors carry no payload and
        // retain EventSource's retry behavior below.
        let code: string | null = null;
        let cursor: string | null = null;
        try {
          const payload: unknown = JSON.parse(String(event.data));
          if (payload !== null && typeof payload === "object") {
            const failure: Record<string, unknown> = { ...payload };
            if (typeof failure.code === "string") code = failure.code;
            if (typeof failure.cursor === "string") cursor = failure.cursor;
          }
        } catch {
          // A malformed server error is still a terminal stream failure.
        }
        terminalError = true;
        es.close();
        flushSignal(code === "invalid_input");
        // A fault the server expects to pass (a database timeout, #3652) is
        // retried from the last frame the route wrote, so nothing is read
        // twice or skipped, until the ceiling is reached.
        if (code === "stream_unavailable" && retries < RETRY_LIMIT) {
          const delay = RETRY_BASE_MS * 2 ** retries;
          retries += 1;
          setState("connecting");
          retryTimer = setTimeout(() => {
            retryTimer = null;
            open(cursor ?? after);
          }, delay);
          return;
        }
        const denied = DENIED_CODES.has(code ?? "");
        if (denied) deniedUrl.current = url;
        setState(denied ? "denied" : "lost");
      });
      es.onerror = () => {
        // EventSource reconnects on its own unless the connection is closed
        // for good; only that second case is a loss the person should see.
        if (es.readyState === EventSource.CLOSED && !stopped && !terminalError)
          setState("lost");
      };
    }

    setState("connecting");
    open(null);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
    };
  }, [url, enabled]);

  return state;
}
