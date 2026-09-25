"use client";
// What one reply cost, read from the run it was recorded as (#4167). The line
// under an answer (`assistant-reply-cost.tsx`) holds nothing of its own: it
// shows what `get_run_cost` answers for the turn's run.
//
// Metering lands after the reply does. The reply comes back as soon as the
// engine answers, and the run's cost row is built afterwards by the rollup,
// so the first read usually finds no row. That is "pending", never a zero. The
// line reads once when the reply lands and, if that read did not find a
// recorded cost, once more after REPLY_COST_REREAD_MS. After the second read
// it shows what the record says and reads no further. A cost that is still
// pending then stays pending on screen, and the run's own page is where a
// later figure appears.
//
// A read that fails is shown as unread, not as pending: the line cannot say
// metering has not landed when it never reached the record. A second read that
// fails leaves the first answer on screen rather than replacing it.
import { useEffect, useState } from "react";
import { type ReplyCost, readReplyCost } from "./assistant-actions";

/**
 * How long after the first read the line reads the record again. A rollup
 * event rebuilds a run's row 30 seconds after the run's latest frames
 * (`packages/inngest-functions/src/functions/cost.run-progress.ts`), and a
 * seal event rebuilds it at once (`cost.run-rollup.ts`). A minute covers the
 * debounce and the job's own run time without holding the line on "pending"
 * for longer than a person reads an answer.
 *
 * An assistant turn's seal sends neither event today, so its row waits for
 * the nightly sweep (`cost.daily-rollup.ts`) and the second read usually
 * finds it pending too. The line then says so, which is what the record says.
 */
export const REPLY_COST_REREAD_MS = 60_000;

/** The line's state: a read in flight, a read that failed, or what the record said. */
export type ReplyCostView = { kind: "reading" } | { kind: "unread" } | ReplyCost;

async function readOnce(
  org: string,
  ws: string,
  runId: string,
): Promise<ReplyCostView> {
  try {
    const result = await readReplyCost(org, ws, runId);
    return result.ok ? result.value : { kind: "unread" };
  } catch {
    // The action threw rather than answering (the network, a server error).
    // The line says the cost was not read, which is what happened.
    return { kind: "unread" };
  }
}

/** Read what the reply recorded as `runId` cost, in the workspace `org/ws`. */
export function useReplyCost(
  org: string,
  ws: string,
  runId: string,
): ReplyCostView {
  const [view, setView] = useState<ReplyCostView>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void readOnce(org, ws, runId).then((first) => {
      if (!live) return;
      setView(first);
      if (first.kind === "recorded") return;
      timer = setTimeout(() => {
        void readOnce(org, ws, runId).then((second) => {
          if (!live || second.kind === "unread") return;
          setView(second);
        });
      }, REPLY_COST_REREAD_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [org, ws, runId]);
  return view;
}
