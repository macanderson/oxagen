import { describe, expect, it } from "vitest";
import {
  buildCountQuery,
  buildStampQuery,
  parseRelTypes,
  runBackfill,
  typeFilter,
  validateRelTypes,
  type BackfillSession,
} from "./lib/backfill-edge-validity";

describe("parseRelTypes", () => {
  it("uppercases and trims a comma list", () => {
    expect(parseRelTypes("implements, depends_on ")).toEqual([
      "IMPLEMENTS",
      "DEPENDS_ON",
    ]);
  });
  it("returns null for empty / absent", () => {
    expect(parseRelTypes(undefined)).toBeNull();
    expect(parseRelTypes("")).toBeNull();
    expect(parseRelTypes("  ,  ")).toBeNull();
  });
});

describe("validateRelTypes", () => {
  it("accepts guard-conforming types", () => {
    expect(() => validateRelTypes(["IMPLEMENTS", "DEPENDS_ON"])).not.toThrow();
    expect(() => validateRelTypes(null)).not.toThrow();
  });
  it("rejects an injection-shaped type", () => {
    expect(() => validateRelTypes(["`]->()-[:x"])).toThrow(
      /Invalid relationship type/,
    );
    expect(() => validateRelTypes(["lowercase"])).toThrow(
      /Invalid relationship type/,
    );
  });
});

describe("query builders", () => {
  it("omits the type filter when no rel-types", () => {
    expect(typeFilter(null)).toBe("");
    expect(buildCountQuery(null)).not.toContain("type(r) IN");
  });
  it("adds a parameterised type filter when rel-types given", () => {
    expect(typeFilter(["IMPLEMENTS"])).toContain("type(r) IN $relTypes");
    expect(buildStampQuery(["IMPLEMENTS"])).toContain("type(r) IN $relTypes");
  });
  it("stamp query is idempotent (only touches unstamped edges) and coalesces createdAt", () => {
    const q = buildStampQuery(null);
    expect(q).toContain("WHERE r.recordedAt IS NULL");
    expect(q).toContain("r.recordedAt = coalesce(r.createdAt, datetime())");
    expect(q).toContain(
      "r.validFrom  = coalesce(r.validFrom, r.createdAt, datetime())",
    );
    // Never closes an edge — validTo / invalidatedAt are left absent.
    expect(q).not.toContain("validTo");
    expect(q).not.toContain("invalidatedAt");
  });
});

/** A fake session that drains a queue of `stamped` batch counts, tracking calls. */
function fakeSession(script: {
  remainingBefore: number;
  batches: number[];
  remainingAfter: number;
}): {
  session: BackfillSession;
  countQueries: number;
  stampQueries: number;
} {
  const state = { count: 0, stamp: 0, batchIdx: 0 };
  const rec = (key: string, value: number) => ({
    records: [{ get: (k: string) => (k === key ? value : null) }],
  });
  const session: BackfillSession = {
    async run(cypher: string) {
      if (cypher.includes("RETURN count(r) AS remaining")) {
        state.count += 1;
        // First count = before, subsequent = after.
        return rec(
          "remaining",
          state.count === 1 ? script.remainingBefore : script.remainingAfter,
        );
      }
      state.stamp += 1;
      const n = script.batches[state.batchIdx] ?? 0;
      state.batchIdx += 1;
      return rec("stamped", n);
    },
  };
  return {
    session,
    get countQueries() {
      return state.count;
    },
    get stampQueries() {
      return state.stamp;
    },
  } as { session: BackfillSession; countQueries: number; stampQueries: number };
}

describe("runBackfill", () => {
  it("loops stamp batches until a batch stamps 0, then re-counts", async () => {
    const { session } = fakeSession({
      remainingBefore: 12,
      batches: [5, 5, 2, 0],
      remainingAfter: 0,
    });
    const result = await runBackfill(session, {
      batchSize: 5,
      dryRun: false,
      relTypes: null,
    });
    expect(result.remainingBefore).toBe(12);
    expect(result.stamped).toBe(12);
    expect(result.remainingAfter).toBe(0);
  });

  it("dry-run counts but writes nothing", async () => {
    const fake = fakeSession({
      remainingBefore: 7,
      batches: [7, 0],
      remainingAfter: 0,
    });
    const result = await runBackfill(fake.session, {
      batchSize: 100,
      dryRun: true,
      relTypes: null,
    });
    expect(result.stamped).toBe(0);
    expect(result.remainingBefore).toBe(7);
    expect(fake.stampQueries).toBe(0); // no stamp query ran
  });

  it("is idempotent — a re-run over an already-stamped graph stamps nothing", async () => {
    // remainingBefore=0 means everything is already stamped: no stamp queries.
    const fake = fakeSession({
      remainingBefore: 0,
      batches: [],
      remainingAfter: 0,
    });
    const result = await runBackfill(fake.session, {
      batchSize: 5000,
      dryRun: false,
      relTypes: null,
    });
    expect(result.stamped).toBe(0);
    expect(fake.stampQueries).toBe(0);
  });

  it("validates rel-types before running", async () => {
    const { session } = fakeSession({
      remainingBefore: 0,
      batches: [],
      remainingAfter: 0,
    });
    await expect(
      runBackfill(session, {
        batchSize: 10,
        dryRun: false,
        relTypes: ["bad type"],
      }),
    ).rejects.toThrow(/Invalid relationship type/);
  });
});
