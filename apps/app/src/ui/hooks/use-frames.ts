"use client";
// useFrames: a run's frames, server-rendered first, then appended live over the
// stream (plan §4.9). Idempotent: a frame delivered twice (a reconnect replay,
// or a server re-render that already includes it) appears once, in seq order.
import { useState } from "react";
import { lastSeq, mergeBySeq } from "./stream-merge";
import {
  type StreamState,
  streamUrl,
  useEventStream,
} from "./use-event-stream";

export type UseFramesOptions<F extends { readonly seq: string }> = {
  org: string;
  ws: string;
  runId: string;
  /** Frames the server rendered; the stream resumes after the highest seq. */
  initial: readonly F[];
  /** The frame view-model schema's parse (e.g. `Frame.parse`). */
  parse: (data: unknown) => F;
  /** False keeps the stream closed (a sealed run has nothing more to send). */
  live?: boolean;
};

export function useFrames<F extends { readonly seq: string }>(
  options: UseFramesOptions<F>,
): { frames: readonly F[]; state: StreamState } {
  const { org, ws, runId, initial, parse, live = true } = options;
  const [streamed, setStreamed] = useState<readonly F[]>([]);
  const state = useEventStream<F>({
    url: live
      ? streamUrl(org, ws, { run: runId, after: lastSeq(initial) })
      : null,
    event: "frame",
    parse,
    onItems: (items) => {
      setStreamed((prev) => mergeBySeq(prev, items));
    },
  });
  return { frames: mergeBySeq(initial, streamed), state };
}
