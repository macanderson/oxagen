"use client";
// The one client transport for Mission Control's live data: an EventSource on
// GET /api/mc/{org}/{ws}/stream (plan §4.9). useFrames and useFleetLive are the
// two hooks built on it; pages use those, not this.
//
// - Items are parsed by the caller's schema (`parse`), never cast. A payload
//   that fails to parse closes the stream with a `stream_payload_invalid` state.
// - Items are delivered in batches (one render per FLUSH_MS at most), so a
//   burst of 200 frames is one render, not 200.
// - An `event: state` carries a Read failure (not_backed, denied, error). The
//   stream closes, so EventSource does not reconnect into the same answer.
// - Reconnects are EventSource's own: it resends the last event id as
//   Last-Event-ID and the route resumes after it.
import { useEffect, useEffectEvent, useState } from "react";
import type { ReadFailure } from "@/data/not-backed";

export type StreamStatus = "connecting" | "open" | "closed";

export type StreamState = {
  status: StreamStatus;
  /** Set when the server answered with a failed read, or sent a bad payload. */
  failure: ReadFailure | null;
};

/** Longest a delivered item waits before it renders. */
export const FLUSH_MS = 50;

export const STREAM_PAYLOAD_INVALID: ReadFailure = {
  ok: false,
  reason: "error",
  code: "stream_payload_invalid",
  status: 502,
};

export function streamUrl(
  org: string,
  ws: string,
  query: { run?: string; after: string },
): string {
  const params = new URLSearchParams();
  if (query.run !== undefined) params.set("run", query.run);
  params.set("after", query.after);
  return `/api/mc/${encodeURIComponent(org)}/${encodeURIComponent(ws)}/stream?${params.toString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A Read failure as the route streams it, checked field by field. */
export function isReadFailure(value: unknown): value is ReadFailure {
  if (!isRecord(value) || value.ok !== false) return false;
  switch (value.reason) {
    case "not_backed":
      return (
        typeof value.milestone === "string" &&
        typeof value.gap === "string" &&
        /^G\d+$/.test(value.gap)
      );
    case "denied":
      return typeof value.permission === "string";
    case "error":
      return typeof value.code === "string" && typeof value.status === "number";
    default:
      return false;
  }
}

function parseJson(
  data: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (typeof data !== "string") return { ok: false };
  try {
    const value: unknown = JSON.parse(data);
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

export type EventStreamOptions<T> = {
  /** Null keeps the stream closed. A new URL reconnects. */
  url: string | null;
  /** The SSE event carrying items (`frame`, `patch`). */
  event: string;
  /** Validate one item; throw to reject it. */
  parse: (data: unknown) => T;
  onItems: (items: readonly T[]) => void;
};

export function useEventStream<T>(options: EventStreamOptions<T>): StreamState {
  const { url, event } = options;
  const [state, setState] = useState<StreamState>({
    status: url === null ? "closed" : "connecting",
    failure: null,
  });
  const parseItem = useEffectEvent((data: unknown): T => options.parse(data));
  const deliver = useEffectEvent((items: readonly T[]) => {
    options.onItems(items);
  });

  useEffect(() => {
    if (url === null) return;
    const source = new EventSource(url);
    let buffer: T[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const flush = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (buffer.length === 0) return;
      const items = buffer;
      buffer = [];
      deliver(items);
    };
    const close = (failure: ReadFailure) => {
      flush();
      closed = true;
      source.close();
      setState({ status: "closed", failure });
    };

    source.onopen = () => {
      setState((s) =>
        s.status === "open" && s.failure === null
          ? s
          : { status: "open", failure: null },
      );
    };
    source.onerror = () => {
      if (closed) return;
      const status: StreamStatus =
        source.readyState === EventSource.CLOSED ? "closed" : "connecting";
      setState((s) => (s.status === status ? s : { ...s, status }));
    };
    source.addEventListener(event, (message: MessageEvent<unknown>) => {
      if (closed) return;
      const json = parseJson(message.data);
      let item: T;
      try {
        if (!json.ok) throw new Error("not JSON");
        item = parseItem(json.value);
      } catch {
        close(STREAM_PAYLOAD_INVALID);
        return;
      }
      buffer.push(item);
      timer ??= setTimeout(flush, FLUSH_MS);
    });
    source.addEventListener("state", (message: MessageEvent<unknown>) => {
      if (closed) return;
      const json = parseJson(message.data);
      close(
        json.ok && isReadFailure(json.value)
          ? json.value
          : STREAM_PAYLOAD_INVALID,
      );
    });

    return () => {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      source.close();
    };
  }, [url, event]);

  return state;
}
