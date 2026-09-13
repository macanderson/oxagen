"use client";
// useFleetLive: the Fleet list, server-rendered first, then patched live over
// the stream (plan §4.9). Each patch upserts or removes one run row. A patch at
// or below the last applied seq is a replay and changes nothing.
import { useState } from "react";
import {
  type FleetLiveState,
  type FleetPatch,
  applyFleetPatch,
  emptyFleetLive,
  selectFleetRows,
} from "./stream-merge";
import {
  type StreamState,
  streamUrl,
  useEventStream,
} from "./use-event-stream";

export type UseFleetLiveOptions<Row extends { readonly id: string }> = {
  org: string;
  ws: string;
  /** Rows the server rendered. */
  initial: readonly Row[];
  /** The patch seq the server rendered at; the stream resumes after it. */
  after: string;
  /** Validates one patch, including its row (e.g. a zod union's parse). */
  parse: (data: unknown) => FleetPatch<Row>;
};

export function useFleetLive<Row extends { readonly id: string }>(
  options: UseFleetLiveOptions<Row>,
): { rows: readonly Row[]; state: StreamState } {
  const { org, ws, initial, after, parse } = options;
  const [patches, setPatches] = useState<FleetLiveState<Row>>(emptyFleetLive);
  const state = useEventStream<FleetPatch<Row>>({
    url: streamUrl(org, ws, { after }),
    event: "patch",
    parse,
    onItems: (items) => {
      setPatches((prev) =>
        items.reduce((acc, patch) => applyFleetPatch(acc, patch), prev),
      );
    },
  });
  return { rows: selectFleetRows(initial, patches), state };
}
