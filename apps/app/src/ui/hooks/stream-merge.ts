// Pure merges behind useFrames and useFleetLive. Delivery over the stream is
// at-least-once (spec §15): a reconnect can replay events, and a server
// re-render can hand the hook data the stream already delivered. Every merge
// here is idempotent, so applying the same event twice changes nothing.

import { compareSeq, isStreamSeq } from "@/server/stream-seq";

export type Seq = string;

export { compareSeq, isStreamSeq as isSeq };

/**
 * Merge frames into an ascending-by-seq list, dropping any seq already present.
 * Returns `base` itself when nothing new arrived, so React skips the render.
 */
export function mergeBySeq<T extends { readonly seq: Seq }>(
  base: readonly T[],
  incoming: readonly T[],
): readonly T[] {
  if (incoming.length === 0) return base;
  const seen = new Set(base.map((f) => f.seq));
  const fresh: T[] = [];
  for (const item of incoming) {
    if (seen.has(item.seq)) continue;
    seen.add(item.seq);
    fresh.push(item);
  }
  if (fresh.length === 0) return base;
  const merged = [...base, ...fresh];
  // Fast path: the stream delivers in order, so only the appended tail is checked.
  for (let i = Math.max(1, base.length); i < merged.length; i += 1) {
    const prev = merged[i - 1];
    const next = merged[i];
    if (prev && next && compareSeq(prev.seq, next.seq) > 0)
      return merged.sort((a, b) => compareSeq(a.seq, b.seq));
  }
  return merged;
}

/** The highest seq in a list, or "0" for an empty one. */
export function lastSeq(items: readonly { readonly seq: Seq }[]): Seq {
  let max: Seq = "0";
  for (const item of items) if (compareSeq(item.seq, max) > 0) max = item.seq;
  return max;
}

export type FleetPatch<Row extends { readonly id: string }> =
  | { readonly seq: Seq; readonly op: "upsert"; readonly row: Row }
  | { readonly seq: Seq; readonly op: "remove"; readonly id: string };

/** Per-row latest patch the stream delivered, keyed by row id. */
export type FleetLiveState<Row extends { readonly id: string }> = {
  readonly lastSeq: Seq;
  readonly rows: ReadonlyMap<string, { seq: Seq; row: Row | null }>;
};

export function emptyFleetLive<
  Row extends { readonly id: string },
>(): FleetLiveState<Row> {
  return { lastSeq: "0", rows: new Map() };
}

/**
 * Apply one patch. A patch at or below the state's cursor is a replay and is
 * ignored (the state object is returned unchanged).
 */
export function applyFleetPatch<Row extends { readonly id: string }>(
  state: FleetLiveState<Row>,
  patch: FleetPatch<Row>,
): FleetLiveState<Row> {
  if (compareSeq(patch.seq, state.lastSeq) <= 0) return state;
  const id = patch.op === "upsert" ? patch.row.id : patch.id;
  const rows = new Map(state.rows);
  rows.set(id, {
    seq: patch.seq,
    row: patch.op === "upsert" ? patch.row : null,
  });
  return { lastSeq: patch.seq, rows };
}

/**
 * The rows to render: the server-rendered list with live patches applied.
 * A patched row replaces its original in place; a removed row is dropped; a
 * row the server list did not have is prepended, newest patch first.
 */
export function selectFleetRows<Row extends { readonly id: string }>(
  initial: readonly Row[],
  live: FleetLiveState<Row>,
): readonly Row[] {
  if (live.rows.size === 0) return initial;
  const known = new Set(initial.map((r) => r.id));
  const added = [...live.rows.entries()]
    .filter(([id, entry]) => !known.has(id) && entry.row !== null)
    .sort(([, a], [, b]) => compareSeq(b.seq, a.seq))
    .flatMap(([, entry]) => (entry.row ? [entry.row] : []));
  const kept = initial.flatMap((row) => {
    const entry = live.rows.get(row.id);
    if (!entry) return [row];
    return entry.row ? [entry.row] : [];
  });
  return [...added, ...kept];
}
