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
  forgeOf,
  type ListQuery,
  listRuns,
  liveCount,
  oldestApproval,
  parkedRunIds,
  pullRequestCount,
  pullRequestLabel,
  type RowWords,
  rowState,
  shownCost,
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
      estimated: 0,
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

  it("counts the priced rows whose cost is a running estimate, and keeps them in the total (#3980)", () => {
    const spend = spendShown(
      listRuns(
        [
          runRow({
            id: "arun_open",
            status: "live",
            cost: usd("1000000"),
            costIsEstimate: true,
          }),
          runRow({ id: "arun_done", cost: usd("2000000") }),
          // No cost is no estimate either.
          runRow({ id: "arun_none", cost: null, costIsEstimate: true }),
        ],
        new Set(),
      ),
    );
    expect(spend.estimated).toBe(1);
    expect(spend.total).toMatchObject({ micros: "3000000", currency: "USD" });
    expect(spend.unpriced).toBe(1);
  });

  // Until a rollup lands, the Run page shows the agent's reported cost as an
  // estimate, and so does the row, so the tile adds the figure the row shows.
  it("sums the agent's reported cost where no rollup is recorded yet, as an estimate", () => {
    const spend = spendShown(
      listRuns(
        [
          runRow({
            id: "tse_reported",
            source: "tacho",
            status: "sealed",
            cost: null,
            reportedCost: usd("1250000", "client_attested"),
          }),
          runRow({ id: "arun_done", cost: usd("2000000") }),
          runRow({ id: "arun_none", cost: null }),
        ],
        new Set(),
      ),
    );
    expect(spend.total).toMatchObject({ micros: "3250000", currency: "USD" });
    expect(spend.bases).toEqual(["client_attested", "gateway_observed"]);
    expect(spend.estimated).toBe(1);
    expect(spend.unpriced).toBe(1);
  });

  it("shows the rollup's figure over the agent's report (negative)", () => {
    expect(
      shownCost(
        runRow({
          cost: usd("2000000"),
          reportedCost: usd("1250000", "client_attested"),
        }),
      ),
    ).toEqual({ value: usd("2000000"), reported: false, estimate: false });
    expect(shownCost(runRow({ cost: null, reportedCost: null }))).toBeNull();
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

  it("finds the oldest approval wherever it sits in the queue", () => {
    expect(
      oldestApproval([
        approvalItem({
          id: "apr_newer",
          createdAt: "2026-09-15T08:59:00.000Z",
          expiresAt: "2026-09-15T09:09:00.000Z",
        }),
        approvalItem({
          id: "apr_older",
          createdAt: "2026-09-15T08:50:00.000Z",
          expiresAt: "2026-09-15T08:55:00.000Z",
        }),
      ])?.createdAt,
    ).toBe(Date.parse("2026-09-15T08:50:00.000Z"));
  });

  it("never reads a negative window for an approval that expires before it was made (negative)", () => {
    expect(
      oldestApproval([
        approvalItem({
          createdAt: "2026-09-15T08:55:00.000Z",
          expiresAt: "2026-09-15T08:50:00.000Z",
        }),
      ])?.windowSeconds,
    ).toBe(0);
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

  it("sorts a text column in natural order both ways", () => {
    const named = words.map((w, i) => ({
      ...w,
      agent: `agent-${String(12 - i)}`,
    }));
    const up = applyList(rows, named, {
      ...base,
      perPage: 0,
      sort: { key: "agent", dir: 1 },
    }).rows;
    // agent-1 (row 11) before agent-2 (row 10) before agent-10 (row 2):
    // numeric collation, not "agent-10" < "agent-2".
    expect(up.slice(0, 3)).toEqual([11, 10, 9]);
    expect(up.at(-1)).toBe(0);
    const down = applyList(rows, named, {
      ...base,
      perPage: 0,
      sort: { key: "agent", dir: -1 },
    }).rows;
    expect(down[0]).toBe(0);
  });

  it("sorts on when a run started", () => {
    const started = listRuns(
      [
        runRow({ id: "arun_late", startedAt: "2026-09-15T08:30:00.000Z" }),
        runRow({ id: "arun_early", startedAt: "2026-09-15T07:00:00.000Z" }),
        runRow({ id: "arun_mid", startedAt: "2026-09-15T08:00:00.000Z" }),
      ],
      new Set(),
    );
    const startedWords = words.slice(0, 3);
    expect(
      applyList(started, startedWords, {
        ...base,
        sort: { key: "started", dir: 1 },
      }).rows,
    ).toEqual([1, 2, 0]);
    expect(
      applyList(started, startedWords, {
        ...base,
        sort: { key: "started", dir: -1 },
      }).rows,
    ).toEqual([0, 2, 1]);
  });

  it("keeps the order the read returned for rows that compare equal, in either direction", () => {
    const dirs: (1 | -1)[] = [1, -1];
    for (const dir of dirs)
      expect(
        applyList(rows, words, {
          ...base,
          perPage: 0,
          sort: { key: "operator", dir },
        }).rows,
      ).toEqual(rows.map((_, i) => i));
  });

  it("keeps two unpriced rows in read order after every priced row", () => {
    const unpriced = listRuns(
      [
        runRow({ id: "arun_a", cost: null }),
        runRow({ id: "arun_b", cost: usd("1000000") }),
        runRow({ id: "arun_c", cost: null }),
      ],
      new Set(),
    );
    expect(
      applyList(unpriced, words.slice(0, 3), {
        ...base,
        sort: { key: "cost", dir: -1 },
      }).rows,
    ).toEqual([1, 0, 2]);
  });

  it("sorts a reported cost among the priced rows, where its figure falls", () => {
    const reported = listRuns(
      [
        runRow({ id: "arun_a", cost: null }),
        runRow({ id: "arun_b", cost: usd("1000000") }),
        runRow({
          id: "tse_c",
          cost: null,
          reportedCost: usd("3000000", "client_attested"),
        }),
      ],
      new Set(),
    );
    expect(
      applyList(reported, words.slice(0, 3), {
        ...base,
        sort: { key: "cost", dir: -1 },
      }).rows,
    ).toEqual([2, 1, 0]);
  });

  it("lists no row it was given no words for (negative)", () => {
    expect(applyList(rows, words.slice(0, 2), base)).toMatchObject({
      rows: [0, 1],
      total: 2,
    });
  });

  it("answers an empty range when nothing matches (negative)", () => {
    expect(
      applyList(rows, words, { ...base, search: "nothing like this" }),
    ).toMatchObject({ rows: [], total: 0, from: 0, to: 0, pages: 1 });
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

describe("how a row names its pull requests", () => {
  const pull = (
    url: string,
    number: number | null,
    repository: string | null,
  ) => ({
    url,
    number,
    repository,
    state: null,
  });

  it("names the forge by host, and a self-hosted one as none", () => {
    expect(forgeOf("https://github.com/a/b/pull/1")).toBe("github");
    expect(forgeOf("https://gitlab.com/g/p/-/merge_requests/2")).toBe("gitlab");
    expect(forgeOf("https://git.acme.example/a/b/pull/1")).toBeNull();
    expect(forgeOf("not a url")).toBeNull();
  });

  it("writes owner/repo#N on GitHub and group/project!N on GitLab", () => {
    expect(
      pullRequestLabel(
        pull("https://github.com/acme/api/pull/42", 42, "acme/api"),
      ),
    ).toBe("acme/api#42");
    expect(
      pullRequestLabel(
        pull("https://gitlab.com/acme/web/-/merge_requests/9", 9, "acme/web"),
      ),
    ).toBe("acme/web!9");
  });

  it("leaves out what the frame did not record (negative)", () => {
    expect(
      pullRequestLabel(pull("https://github.com/acme/api/pull/42", 42, null)),
    ).toBe("#42");
    expect(
      pullRequestLabel(
        pull("https://github.com/acme/api/pull/42", null, "acme/api"),
      ),
    ).toBe("acme/api");
    expect(
      pullRequestLabel(pull("https://github.com/acme/api/pull/42", null, null)),
    ).toBeNull();
  });

  it("counts the links, or the opened calls when more were counted, and nothing it did not read", () => {
    const link = pull("https://github.com/a/b/pull/1", 1, "a/b");
    expect(
      pullRequestCount(runRow({ pullRequests: [link], pullRequestsOpened: 0 })),
    ).toBe(1);
    expect(
      pullRequestCount(runRow({ pullRequests: [], pullRequestsOpened: 3 })),
    ).toBe(3);
    expect(pullRequestCount(runRow({ pullRequests: [] }))).toBe(0);
    expect(pullRequestCount(runRow({}))).toBeNull();
  });
});
