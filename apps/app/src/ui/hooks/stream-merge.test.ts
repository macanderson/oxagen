import { describe, expect, it } from "vitest";
import {
  applyFleetPatch,
  compareSeq,
  emptyFleetLive,
  isSeq,
  lastSeq,
  mergeBySeq,
  selectFleetRows,
  type FleetPatch,
} from "./stream-merge";

type F = { seq: string; kind: string };
const f = (seq: string, kind = "tool.result"): F => ({ seq, kind });
const seqs = (list: readonly F[]) => list.map((x) => x.seq);

describe("mergeBySeq (idempotent append)", () => {
  it("appends new frames in order", () => {
    expect(seqs(mergeBySeq([f("1"), f("2")], [f("3"), f("4")]))).toEqual([
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("delivering the same frame twice appends it once", () => {
    const once = mergeBySeq([f("1")], [f("2")]);
    const twice = mergeBySeq(once, [f("2")]);
    expect(seqs(twice)).toEqual(["1", "2"]);
    expect(twice).toBe(once);
  });

  it("dedupes within one batch and against the base", () => {
    expect(seqs(mergeBySeq([f("1")], [f("2"), f("2"), f("1")]))).toEqual([
      "1",
      "2",
    ]);
  });

  it("returns the base itself when nothing new arrived", () => {
    const base = [f("1")];
    expect(mergeBySeq(base, [])).toBe(base);
    expect(mergeBySeq(base, [f("1")])).toBe(base);
  });

  it("keeps seq order when a replay arrives out of order, comparing as bigints", () => {
    expect(
      seqs(mergeBySeq([f("2"), f("10")], [f("9"), f("11"), f("3")])),
    ).toEqual(["2", "3", "9", "10", "11"]);
    expect(
      seqs(mergeBySeq([f("9007199254740993")], [f("9007199254740992")])),
    ).toEqual(["9007199254740992", "9007199254740993"]);
  });

  it("merges into an empty base", () => {
    expect(seqs(mergeBySeq([], [f("5"), f("4")]))).toEqual(["4", "5"]);
  });
});

describe("seq helpers", () => {
  it("lastSeq is the highest seq, or 0", () => {
    expect(lastSeq([])).toBe("0");
    expect(lastSeq([f("10"), f("9")])).toBe("10");
  });

  it("isSeq accepts decimal text only", () => {
    expect(isSeq("12")).toBe(true);
    expect(isSeq(12)).toBe(false);
    expect(isSeq("-1")).toBe(false);
    expect(compareSeq("1", "2")).toBe(-1);
  });
});

type Row = { id: string; status: string };
const upsert = (seq: string, id: string, status: string): FleetPatch<Row> => ({
  seq,
  op: "upsert",
  row: { id, status },
});
const remove = (seq: string, id: string): FleetPatch<Row> => ({
  seq,
  op: "remove",
  id,
});

describe("fleet patches (idempotent apply)", () => {
  const initial: Row[] = [
    { id: "arun_a", status: "live" },
    { id: "arun_b", status: "live" },
  ];

  it("returns the initial rows untouched with no patches", () => {
    expect(selectFleetRows(initial, emptyFleetLive<Row>(), "0")).toBe(initial);
  });

  it("replaces a patched row in place, drops a removed row, prepends a new row newest first", () => {
    let live = emptyFleetLive<Row>();
    for (const p of [
      upsert("1", "arun_a", "paused"),
      upsert("2", "arun_c", "live"),
      remove("3", "arun_b"),
      upsert("4", "arun_d", "live"),
    ])
      live = applyFleetPatch(live, p);
    expect(selectFleetRows(initial, live, "0")).toEqual([
      { id: "arun_d", status: "live" },
      { id: "arun_c", status: "live" },
      { id: "arun_a", status: "paused" },
    ]);
  });

  it("ignores a replayed or older patch (same object back)", () => {
    const once = applyFleetPatch(
      emptyFleetLive<Row>(),
      upsert("5", "arun_a", "sealed"),
    );
    expect(applyFleetPatch(once, upsert("5", "arun_a", "sealed"))).toBe(once);
    expect(applyFleetPatch(once, upsert("4", "arun_a", "live"))).toBe(once);
    expect(selectFleetRows(initial, once, "0")[0]).toEqual({
      id: "arun_a",
      status: "sealed",
    });
  });

  it("starts the cursor at the rendered seq, so an older patch is ignored", () => {
    const live = emptyFleetLive<Row>("10");
    expect(live.lastSeq).toBe("10");
    expect(applyFleetPatch(live, upsert("10", "arun_a", "sealed"))).toBe(live);
    expect(applyFleetPatch(live, upsert("9", "arun_a", "sealed"))).toBe(live);
  });

  it("lets fresher server rows win over a patch at or below the rendered seq", () => {
    let live = emptyFleetLive<Row>();
    for (const p of [
      upsert("5", "arun_a", "running"),
      remove("6", "arun_b"),
      upsert("7", "arun_x", "live"),
      upsert("12", "arun_y", "live"),
    ])
      live = applyFleetPatch(live, p);
    const fresh: Row[] = [
      { id: "arun_a", status: "done" },
      { id: "arun_b", status: "live" },
    ];
    // Rendered at 10: patches 5, 6 and 7 are already reflected in `fresh`.
    expect(selectFleetRows(fresh, live, "10")).toEqual([
      { id: "arun_y", status: "live" },
      { id: "arun_a", status: "done" },
      { id: "arun_b", status: "live" },
    ]);
    // Rendered at 12: every patch is stale, the server list comes back as-is.
    expect(selectFleetRows(fresh, live, "12")).toBe(fresh);
  });

  it("a row created then removed never appears", () => {
    let live = applyFleetPatch(
      emptyFleetLive<Row>(),
      upsert("1", "arun_x", "live"),
    );
    live = applyFleetPatch(live, remove("2", "arun_x"));
    expect(selectFleetRows(initial, live, "0").map((r) => r.id)).toEqual([
      "arun_a",
      "arun_b",
    ]);
  });
});
