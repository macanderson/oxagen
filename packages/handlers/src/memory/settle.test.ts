import { describe, expect, it } from "vitest";
import { settleMemoryPr } from "./settle";
import type { MemoryPrRecord, OpenMemoryPr, PrState } from "./types";

const NOW = new Date("2026-09-26T12:00:00Z");
const MERGED_AT = new Date("2026-09-26T09:30:00Z");

function propose(
  lineage: string,
  memoryIds: string[],
  statementHashes: string[],
): MemoryPrRecord {
  return {
    action: "propose",
    lineage,
    path: `steering/memory/workspace/general/${lineage}.md`,
    kind: "memory",
    memoryIds,
    statementHashes,
  };
}

function retire(lineage: string): MemoryPrRecord {
  return {
    action: "retire",
    lineage,
    path: `steering/memory/workspace/general/${lineage}.md`,
    kind: "fact",
    memoryIds: [],
    statementHashes: [],
  };
}

function openPr(records: MemoryPrRecord[]): OpenMemoryPr {
  return {
    id: "pr-1",
    provider: "github",
    repository: "github.com/acme/steering",
    branch: "memory/2026-09-25",
    number: 12,
    url: "https://github.com/acme/steering/pull/12",
    records,
    openedAt: new Date("2026-09-25T06:00:00Z"),
  };
}

const MERGED: PrState = { open: false, merged: true, mergedAt: MERGED_AT };
const CLOSED: PrState = { open: false, merged: false, mergedAt: null };

describe("settleMemoryPr", () => {
  it("returns null while the PR is open", () => {
    const pr = openPr([propose("run-tests", ["m1"], ["h1"])]);
    expect(
      settleMemoryPr(pr, { open: true, merged: false, mergedAt: null }, new Set(), NOW),
    ).toBeNull();
  });

  it("merges each proposed record still at its path, and rejects one the person removed", () => {
    const kept = propose("run-tests", ["m1", "m2"], ["h1"]);
    const removed = propose("skip-lint", ["m3"], ["h2", "h3"]);
    const settlement = settleMemoryPr(
      openPr([kept, removed]),
      MERGED,
      new Set([kept.path]),
      NOW,
    );
    expect(settlement).toEqual({
      prId: "pr-1",
      status: "merged",
      settledAt: MERGED_AT,
      mergedLineages: ["run-tests"],
      reviewedLineages: [],
      rejectedHashes: ["h2", "h3"],
      purgeMemoryIds: ["m1", "m2", "m3"],
    });
  });

  it("settles at now when the provider gives no merge time", () => {
    const settlement = settleMemoryPr(
      openPr([propose("run-tests", ["m1"], ["h1"])]),
      { open: false, merged: true, mergedAt: null },
      new Set(),
      NOW,
    );
    expect(settlement?.status).toBe("merged");
    expect(settlement?.settledAt).toBe(NOW);
  });

  it("rejects every proposed record of a PR closed unmerged, whatever the paths say", () => {
    const record = propose("run-tests", ["m1"], ["h1"]);
    const settlement = settleMemoryPr(
      openPr([record]),
      { open: false, merged: false, mergedAt: MERGED_AT },
      new Set([record.path]),
      NOW,
    );
    expect(settlement).toEqual({
      prId: "pr-1",
      status: "closed",
      settledAt: NOW,
      mergedLineages: [],
      reviewedLineages: [],
      rejectedHashes: ["h1"],
      purgeMemoryIds: ["m1"],
    });
  });

  it("marks every retirement reviewed, merged or closed", () => {
    const record = retire("old-fact");
    const merged = settleMemoryPr(openPr([record]), MERGED, new Set(), NOW);
    const closed = settleMemoryPr(
      openPr([record]),
      CLOSED,
      new Set([record.path]),
      NOW,
    );
    for (const settlement of [merged, closed]) {
      expect(settlement?.reviewedLineages).toEqual(["old-fact"]);
      expect(settlement?.mergedLineages).toEqual([]);
      expect(settlement?.rejectedHashes).toEqual([]);
      expect(settlement?.purgeMemoryIds).toEqual([]);
    }
  });

  it("lists each lineage, hash, and memory id once", () => {
    const settlement = settleMemoryPr(
      openPr([
        propose("run-tests", ["m1", "m2"], ["h1", "h1"]),
        propose("run-tests", ["m2"], ["h1"]),
        retire("old-fact"),
        retire("old-fact"),
      ]),
      CLOSED,
      new Set(),
      NOW,
    );
    expect(settlement?.rejectedHashes).toEqual(["h1"]);
    expect(settlement?.purgeMemoryIds).toEqual(["m1", "m2"]);
    expect(settlement?.reviewedLineages).toEqual(["old-fact"]);

    const merged = settleMemoryPr(
      openPr([
        propose("run-tests", ["m1"], ["h1"]),
        propose("run-tests", ["m2"], ["h2"]),
      ]),
      MERGED,
      new Set(["steering/memory/workspace/general/run-tests.md"]),
      NOW,
    );
    expect(merged?.mergedLineages).toEqual(["run-tests"]);
  });
});
