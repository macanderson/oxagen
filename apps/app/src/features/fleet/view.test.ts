// What Fleet computes from its rows (fleet.md, Functionality): the state a row
// reads as, which rows a chip lists, the tile figures over those rows, and
// the list controls. Each figure is recomputed here from the rows, so a tile
// that disagreed with its table would fail.
import { describe, expect, it } from "vitest";
import { approvalItem, runRow } from "./fleet.builders";
import {
  applyList,
  chipRows,
  facetValues,
  type ListQuery,
  listRuns,
  liveCount,
  oldestApproval,
  pagerSlots,
  parkedRunIds,
  type RowWords,
  rowState,
  rowsPerPageOf,
  spendShown,
  windowParts,
} from "./view";

const usd = (
  micros: string,
  basis: "gateway_observed" | "client_attested" | null = "gateway_observed",
) => ({
  micros,
  currency: "USD",
  basis,
});

const live = runRow({ id: "arun_live", status: "live" });
const parked = runRow({ id: "arun_parked", status: "live" });
const sealed = runRow({
  id: "arun_sealed",
  status: "sealed",
  outcome: "completed",
  cost: usd("2000000", "client_attested"),
});
const halted = runRow({
  id: "arun_halted",
  status: "halted",
  outcome: "cancelled",
  cost: null,
});
const PARKED = parkedRunIds([
  approvalItem({ runId: "arun_parked" }),
  approvalItem({ id: "apr_2", runId: null }),
]);
const all = listRuns([live, parked, sealed, halted], PARKED);

describe("rowState", () => {
  it("reads a live run with a call parked on it as parked", () => {
    expect(rowState(parked, PARKED)).toBe("parked");
    expect(rowState(live, PARKED)).toBe("live");
  });

  it("keeps an ended run's own status even when an approval names it (negative)", () => {
    expect(rowState(sealed, new Set(["arun_sealed"]))).toBe("sealed");
    expect(rowState(halted, PARKED)).toBe("halted");
  });

  it("names only the runs a pending approval carries", () => {
    expect([...PARKED]).toEqual(["arun_parked"]);
  });
});

describe("chipRows", () => {
  const ids = (chip: Parameters<typeof chipRows>[1]) =>
    chipRows(all, chip).map((row) => row.run.id);

  it("lists every row under all, halted ones included", () => {
    expect(ids("all")).toEqual([
      "arun_live",
      "arun_parked",
      "arun_sealed",
      "arun_halted",
    ]);
  });

  it("lists live and parked under live, parked alone under parked, sealed under sealed", () => {
    expect(ids("live")).toEqual(["arun_live", "arun_parked"]);
    expect(ids("parked")).toEqual(["arun_parked"]);
    expect(ids("sealed")).toEqual(["arun_sealed"]);
  });
});

describe("tile figures", () => {
  it("counts a live run and not a parked one as live", () => {
    expect(liveCount(all)).toBe(1);
  });

  it("sums the recorded costs, reads the bases off the rows and counts the rows with none", () => {
    const spend = spendShown(all);
    // 4.131265 + 4.131265 + 2.000000; the halted run recorded no cost.
    expect(spend.total).toEqual({ micros: "10262530", currency: "USD" });
    expect(spend.bases).toEqual(["gateway_observed", "client_attested"]);
    expect(spend.unpriced).toBe(1);
    expect(spend.unbased).toBe(0);
    expect(spend.mixedCurrency).toBe(false);
  });

  it("changes with the chip, because it sums the rows listed", () => {
    expect(spendShown(chipRows(all, "sealed"))).toMatchObject({
      total: { micros: "2000000" },
      bases: ["client_attested"],
    });
  });

  it("answers no total and no basis when no listed row recorded a cost (negative)", () => {
    expect(spendShown(chipRows(all, "all").slice(3))).toEqual({
      total: null,
      bases: [],
      unbased: 0,
      unpriced: 1,
      mixedCurrency: false,
    });
  });

  it("refuses a sum across two currencies and counts a cost with no basis", () => {
    const spend = spendShown(
      listRuns(
        [
          runRow({ id: "arun_a", cost: usd("1000000", null) }),
          runRow({
            id: "arun_b",
            cost: { micros: "1000000", currency: "EUR", basis: null },
          }),
        ],
        new Set(),
      ),
    );
    expect(spend.total).toBeNull();
    expect(spend.mixedCurrency).toBe(true);
    expect(spend.unbased).toBe(2);
  });

  it("finds the oldest pending approval and its window", () => {
    expect(
      oldestApproval([
        approvalItem({
          createdAt: "2026-09-15T08:55:00.000Z",
          expiresAt: "2026-09-15T09:05:00.000Z",
        }),
        approvalItem({
          createdAt: "2026-09-15T08:59:00.000Z",
          expiresAt: "2026-09-15T09:09:00.000Z",
        }),
      ]),
    ).toEqual({
      createdAt: Date.parse("2026-09-15T08:55:00.000Z"),
      windowSeconds: 600,
    });
    expect(oldestApproval([])).toBeNull();
  });
});

describe("the list controls", () => {
  const rows = listRuns(
    Array.from({ length: 12 }, (_, i) =>
      runRow({
        id: `arun_${String(i).padStart(2, "0")}`,
        frames: 100 - i,
        cost: i === 3 ? null : usd(String((i + 1) * 1_000_000)),
        enforcementTier: i % 2 === 0 ? "gateway" : "harness",
      }),
    ),
    new Set(),
  );
  const words: RowWords[] = rows.map(({ run }) => ({
    run: run.id,
    agent: run.agentKey ?? "",
    operator: "Marcus Bell",
    status: "live",
    tier: run.enforcementTier,
    replay: "fork",
    text: `${run.id} ${run.enforcementTier}`,
  }));
  /** One row's words, every column alike but the search text. */
  const wordsAt = (i: number): RowWords => ({
    run: `arun_${String(i)}`,
    agent: "",
    operator: "Marcus Bell",
    status: "live",
    tier: "harness",
    replay: "fork",
    text: String(i),
  });
  const base: ListQuery = {
    search: "",
    facets: { tier: null, replay: null, status: null },
    sort: null,
    perPage: 5,
    page: 1,
  };

  it("pages the rows and reports the range", () => {
    expect(applyList(rows, words, base)).toMatchObject({
      rows: [0, 1, 2, 3, 4],
      total: 12,
      page: 1,
      pages: 3,
      from: 1,
      to: 5,
    });
    expect(applyList(rows, words, { ...base, page: 3 })).toMatchObject({
      rows: [10, 11],
      from: 11,
      to: 12,
    });
  });

  it("shows every row under All and clamps a page past the end", () => {
    expect(applyList(rows, words, { ...base, perPage: 0 }).rows).toHaveLength(
      12,
    );
    expect(applyList(rows, words, { ...base, page: 9 }).page).toBe(3);
  });

  it("searches every word on the row and filters on a facet", () => {
    expect(applyList(rows, words, { ...base, search: "ARUN_07" }).rows).toEqual(
      [7],
    );
    const gateway = applyList(rows, words, {
      ...base,
      perPage: 0,
      facets: { ...base.facets, tier: "gateway" },
    });
    expect(gateway.total).toBe(6);
    expect(facetValues(words, "tier")).toEqual(["gateway", "harness"]);
  });

  it("sorts on a figure both ways and keeps an unpriced row last", () => {
    const up = applyList(rows, words, {
      ...base,
      perPage: 0,
      sort: { key: "cost", dir: 1 },
    }).rows;
    expect(up.slice(0, 2)).toEqual([0, 1]);
    expect(up.at(-1)).toBe(3);
    const down = applyList(rows, words, {
      ...base,
      perPage: 0,
      sort: { key: "cost", dir: -1 },
    }).rows;
    expect(down[0]).toBe(11);
    expect(down.at(-1)).toBe(3);
    expect(
      applyList(rows, words, {
        ...base,
        perPage: 0,
        sort: { key: "frames", dir: 1 },
      }).rows[0],
    ).toBe(11);
  });

  it("answers an empty range when nothing matches (negative)", () => {
    expect(
      applyList(rows, words, { ...base, search: "nothing like this" }),
    ).toMatchObject({ rows: [], total: 0, from: 0, to: 0, pages: 1 });
  });

  it("draws every page up to seven and elides past that", () => {
    expect(pagerSlots(1, 3)).toEqual([1, 2, 3]);
    expect(pagerSlots(1, 28)).toEqual([1, 2, "gap", 28]);
    expect(pagerSlots(14, 28)).toEqual([1, "gap", 13, 14, 15, "gap", 28]);
  });

  it("draws no trailing gap when the current page sits beside the last", () => {
    expect(pagerSlots(27, 28)).toEqual([1, "gap", 26, 27, 28]);
    expect(pagerSlots(28, 28)).toEqual([1, "gap", 27, 28]);
  });

  it("sorts on when a run started, oldest first or newest first", () => {
    const started = listRuns(
      [
        runRow({ id: "arun_b", startedAt: "2026-09-15T09:00:00.000Z" }),
        runRow({ id: "arun_a", startedAt: "2026-09-15T08:00:00.000Z" }),
        runRow({ id: "arun_c", startedAt: "2026-09-15T10:00:00.000Z" }),
      ],
      new Set(),
    );
    const startedWords = started.map((_, i) => wordsAt(i));
    const sorted = (dir: 1 | -1) =>
      applyList(started, startedWords, {
        ...base,
        sort: { key: "started", dir },
      }).rows;
    expect(sorted(1)).toEqual([1, 0, 2]);
    expect(sorted(-1)).toEqual([2, 0, 1]);
  });

  it("sorts a text column on the words shown, and keeps the read order among equal words", () => {
    const agents = ["zeta", "alpha", "mu", "alpha"];
    const textRows = rows.slice(0, 4);
    const textWords = textRows.map((_, i) => ({
      ...wordsAt(i),
      agent: agents[i] ?? "",
    }));
    const byAgent = (dir: 1 | -1) =>
      applyList(textRows, textWords, {
        ...base,
        sort: { key: "agent", dir },
      }).rows;
    // The two "alpha" rows tie, so the earlier read stays first both ways.
    expect(byAgent(1)).toEqual([1, 3, 2, 0]);
    expect(byAgent(-1)).toEqual([0, 2, 1, 3]);
    // Every row reads "live": the sort changes nothing.
    expect(
      applyList(rows, words, {
        ...base,
        perPage: 0,
        sort: { key: "status", dir: -1 },
      }).rows,
    ).toEqual(rows.map((_, i) => i));
  });

  it("keeps two unpriced rows last and in read order when sorting on cost", () => {
    const priced = listRuns(
      [
        runRow({ id: "arun_n1", cost: null }),
        runRow({ id: "arun_p", cost: usd("1000000") }),
        runRow({ id: "arun_n2", cost: null }),
      ],
      new Set(),
    );
    const pricedWords = priced.map((_, i) => wordsAt(i));
    for (const dir of [1, -1] as const) {
      expect(
        applyList(priced, pricedWords, { ...base, sort: { key: "cost", dir } })
          .rows,
      ).toEqual([1, 0, 2]);
    }
  });

  it("drops a row the caller supplied no words for (negative)", () => {
    const listed = applyList(rows, words.slice(0, 2), { ...base, perPage: 0 });
    expect(listed.rows).toEqual([0, 1]);
    expect(listed.total).toBe(2);
  });

  it("reads a rows-per-page choice, and falls back to 10 for one it does not offer (negative)", () => {
    expect(rowsPerPageOf("25")).toBe(25);
    expect(rowsPerPageOf("0")).toBe(0);
    expect(rowsPerPageOf("7")).toBe(10);
    expect(rowsPerPageOf("many")).toBe(10);
    // A wart, pinned: Number("") is 0, so an empty value reads as All.
    expect(rowsPerPageOf("")).toBe(0);
  });
});

describe("windowParts", () => {
  it("reads an approval window as whole minutes and the seconds left over", () => {
    expect(windowParts(600)).toEqual({ minutes: 10, seconds: 0 });
    expect(windowParts(90)).toEqual({ minutes: 1, seconds: 30 });
    expect(windowParts(599.6)).toEqual({ minutes: 10, seconds: 0 });
  });

  it("never reads a negative window (negative)", () => {
    expect(windowParts(-5)).toEqual({ minutes: 0, seconds: 0 });
  });
});
