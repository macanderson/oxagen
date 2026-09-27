"use client";
// Reading a run's stale light again while its page is open.
//
// The page reads a run as stale (`isStale`) from the row it read when it
// rendered. The header, the run controls and the Transcript tab all read that
// row, and the stream follower owns none of them, so when the stream says the
// reading changed, the follower reads the page again. Two signals say so:
//
// - The route sends the run's row (`event: run`) each time the stream opens,
//   and it reopens a quiet stream every few minutes. A row whose reading
//   differs from the page's means the host went quiet, or came back.
// - A frame landing while the page reads stale means the host is back: ingest
//   records the host as seen when it takes the frame.
import { useRef } from "react";
import { isStale } from "@/data/contracts/runs";
import { useNavigate } from "@/ui/navigation";
import type { StreamRun } from "./use-run-stream";

/**
 * The stream callbacks that read the page again when the stale reading
 * changed. `stale` is the page's own reading. A refresh is asked for once per
 * new reading, so a burst of frames asks once while the page's read is on its
 * way.
 */
export function useStaleRefresh(stale: boolean): {
  onFrames: () => void;
  onRun: (run: StreamRun) => void;
} {
  const navigate = useNavigate();
  // The reading the last refresh asked for; null before any was asked.
  const asked = useRef<boolean | null>(null);
  function refreshTo(next: boolean) {
    if (next === stale) {
      asked.current = null;
      return;
    }
    if (asked.current === next) return;
    asked.current = next;
    navigate.refresh();
  }
  return {
    onFrames: () => {
      if (stale) refreshTo(false);
    },
    onRun: (run) => {
      refreshTo(isStale(run));
    },
  };
}
