// What the one SSE route reads (plan §4.9): frames for a run, patches for the
// fleet. Declared here structurally so the route and the hooks do not depend
// on a view-model module; the data layer's read ports satisfy these shapes.
//
// Until a data source provides a feed, each answers the honest NotBacked state
// the plan's §3 mapping gives it, and the route streams that as an `event:
// state` the page renders like any failed read (never an empty "all quiet"):
//   - run frames: G6 (the :Run/:Frame recorder, M1). The live adapter wraps
//     run-ledger `readAttemptEventsSince` in Batch 3 lane A1.
//   - fleet patches: G3 (the `cost.run_totals` rollup, M2), the same gap that
//     backs the Fleet list itself.
// Wiring a feed is a change to `streamFeeds()` only.
import "server-only";
import { notBacked, type Read } from "@/data/not-backed";
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

export const notBackedStreamFeeds: StreamFeeds = {
  framesSince: () => Promise.resolve(notBacked("M1", "G6")),
  fleetSince: () => Promise.resolve(notBacked("M2", "G3")),
};

export function streamFeeds(): Promise<StreamFeeds> {
  return Promise.resolve(notBackedStreamFeeds);
}
