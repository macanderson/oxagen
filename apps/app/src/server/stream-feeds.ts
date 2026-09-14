// What the one SSE route reads (plan §4.9): frames for a run, patches for the
// fleet. Declared here structurally so the route and the hooks do not depend
// on a view-model module; the data layer's read ports satisfy these shapes.
//
//   - run frames: `dataSource().runs.framesSince`, the same read the Run page
//     renders from. The fixture source streams the seeded run's frames (dev and
//     e2e); the live source answers its backing (src/data/backing.ts) until
//     Batch 3 lane A1 wraps run-ledger `readAttemptEventsSince`.
//   - fleet patches: no read port carries a patch cursor yet, so the feed
//     answers G3 (the `cost.run_totals` rollup, M2), the gap that backs the
//     Fleet list itself. The route streams that as an `event: state` the page
//     renders like any failed read (never an empty "all quiet").
import "server-only";
import { notBacked, type Read } from "@/data/not-backed";
import { dataSource } from "@/data/source";
import type { StreamItem } from "./sse";
import type { Scope } from "./tenant-scope";

export type StreamFeeds = {
  /** Frames of one run with run_seq above `afterSeq`, oldest first. */
  readonly framesSince: (
    scope: Scope,
    runId: string,
    afterSeq: string,
    limit: number,
  ) => Promise<Read<readonly StreamItem[]>>;
  /** Fleet row patches with seq above `afterSeq`, oldest first. */
  readonly fleetSince: (
    scope: Scope,
    afterSeq: string,
    limit: number,
  ) => Promise<Read<readonly StreamItem[]>>;
};

/** The fleet feed until a port reads patches by cursor (G3). */
export const fleetSinceNotBacked: StreamFeeds["fleetSince"] = () =>
  Promise.resolve(notBacked("M2", "G3"));

export async function streamFeeds(): Promise<StreamFeeds> {
  const source = await dataSource();
  return {
    framesSince: (scope, runId, afterSeq, limit) =>
      source.runs.framesSince(scope, runId, afterSeq, limit),
    fleetSince: fleetSinceNotBacked,
  };
}
