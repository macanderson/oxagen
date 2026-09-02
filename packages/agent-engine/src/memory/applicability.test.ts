/**
 * Tests for memory-recall applicability filter (F9).
 *
 * Coverage: lexical overlap rules, stage-1 pruning, stage-2 threshold,
 * scorer error handling, null scorer path, result ordering, tagRecall formatting.
 */

import { describe, it, expect, vi } from "vitest";
import {
  lexicalOverlap,
  filterRecall,
  tagRecall,
  type RecallItem,
  type TaskContext,
  type ApplicabilityScorer,
  type ScoredRecall,
} from "./applicability";

// ── Fixtures ───────────────────────────────────────────────────────────────

const mockContext: TaskContext = {
  issue: "The database connection is timing out when querying large tables",
  candidateFiles: [
    "src/db/connection.ts",
    "src/db/query.ts",
    "tests/db.test.ts",
  ],
};

const mockItems: RecallItem[] = [
  {
    id: "item-1",
    text: "Database connection pooling requires setting max_connections to match the workload",
    kind: "gotcha",
  },
  {
    id: "item-2",
    text: "Always validate user input before passing to database queries",
    kind: "routine-change",
  },
  {
    id: "item-3",
    text: "The API response format has changed in v2",
    kind: "convention-deviation",
  },
  {
    id: "item-4",
    text: "src/db/connection.ts needs timeout configuration for large result sets",
    kind: "gotcha",
  },
  {
    id: "item-5",
    text: "Unrelated lesson about CSS styling in React components",
    kind: "routine-change",
  },
];

/**
 * Stub scorer that returns fixed scores for testing.
 */
function createStubScorer(
  scoreMap: Record<string, { score: number; reason: string }>,
): ApplicabilityScorer {
  return async (items) => {
    return items
      .map((item) => ({
        id: item.id,
        score: scoreMap[item.id]?.score ?? 0,
        reason: scoreMap[item.id]?.reason ?? "scored",
      }))
      .filter((r) => r.score > 0);
  };
}

/**
 * Stub scorer that throws.
 */
function createThrowingScorer(): ApplicabilityScorer {
  return async () => {
    throw new Error("scorer failed");
  };
}

// ── lexicalOverlap tests ───────────────────────────────────────────────────

describe("lexicalOverlap", () => {
  it("counts shared word tokens, ignoring stopwords and short tokens", () => {
    const item: RecallItem = {
      id: "test",
      text: "database connection timeout issues",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // Shared: database, connection (2 tokens)
    // "timeout" and "issues" don't match "timing" and "out" separately
    expect(overlap).toBeGreaterThanOrEqual(2);
  });

  it("returns 0 when no word overlap exists", () => {
    const item: RecallItem = {
      id: "test",
      text: "completely unrelated text about CSS styling",
    };
    const overlap = lexicalOverlap(item, mockContext);
    expect(overlap).toBe(0);
  });

  it("adds +5 bonus for path-token overlap with candidate files", () => {
    const item: RecallItem = {
      id: "test",
      text: "Fix the issue in src/db/connection.ts by adding timeout",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // Should include word overlap + 5 for path match
    expect(overlap).toBeGreaterThan(5);
  });

  it("counts path overlap both directions (item contains candidate or vice versa)", () => {
    const item: RecallItem = {
      id: "test",
      text: "The db/connection module needs configuration",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // "db/connection" should match "src/db/connection.ts" as substring
    expect(overlap).toBeGreaterThan(0);
  });

  it("filters stopwords (the, and, for, with, that, this, from, are, was, not, you, all, can, has, have, when, then, into, only)", () => {
    const item: RecallItem = {
      id: "test",
      text: "the and for with that this from are was not you all can has have when then into only database",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // Only "database" should match; stopwords excluded
    expect(overlap).toBeGreaterThanOrEqual(1);
  });

  it("filters tokens shorter than 3 chars", () => {
    const item: RecallItem = {
      id: "test",
      text: "a to is db connection issue in code",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // "connection" matches; short tokens (a, to, is, db, in) filtered
    expect(overlap).toBeGreaterThanOrEqual(1);
  });

  it("handles empty item text", () => {
    const item: RecallItem = {
      id: "test",
      text: "",
    };
    const overlap = lexicalOverlap(item, mockContext);
    expect(overlap).toBe(0);
  });

  it("is case-insensitive", () => {
    const item: RecallItem = {
      id: "test",
      text: "DATABASE CONNECTION TIMEOUT",
    };
    const overlap = lexicalOverlap(item, mockContext);
    // Should match lowercase tokens
    expect(overlap).toBeGreaterThanOrEqual(2);
  });
});

// ── filterRecall stage 1 tests ─────────────────────────────────────────────

describe("filterRecall stage 1", () => {
  it("drops items with zero lexical overlap", async () => {
    const items: RecallItem[] = [
      { id: "a", text: "completely unrelated CSS styling" },
      { id: "b", text: "database connection timeout" },
    ];
    const result = await filterRecall(items, mockContext, null);
    expect(result.length).toBeLessThan(items.length);
    expect(result.some((r) => r.item.id === "a")).toBe(false);
    expect(result.some((r) => r.item.id === "b")).toBe(true);
  });

  it("caps survivors at maxSurvivors (default 8)", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      id: `item-${i}`,
      text: "database connection timeout issues",
    }));
    const result = await filterRecall(items, mockContext, null, {
      maxSurvivors: 8,
    });
    expect(result.length).toBeLessThanOrEqual(8);
  });

  it("respects custom maxSurvivors", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      id: `item-${i}`,
      text: "database connection timeout",
    }));
    const result = await filterRecall(items, mockContext, null, {
      maxSurvivors: 3,
    });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("preserves original order on overlap ties", async () => {
    const items: RecallItem[] = [
      { id: "a", text: "database timeout" },
      { id: "b", text: "database timeout" }, // Same overlap as 'a'
      { id: "c", text: "database timeout" }, // Same overlap
    ];
    const result = await filterRecall(items, mockContext, null);
    // All should survive with same overlap; order should be preserved
    expect(result.length).toBe(3);
    expect(result[0]?.item.id).toBe("a");
    expect(result[1]?.item.id).toBe("b");
    expect(result[2]?.item.id).toBe("c");
  });

  it("returns stage-1 survivors with score -1 and reason 'lexical-only' when scorer is null", async () => {
    const result = await filterRecall(mockItems, mockContext, null);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.score === -1)).toBe(true);
    expect(result.every((r) => r.reason === "lexical-only")).toBe(true);
  });

  it("returns stage-1 survivors with score -1 and reason 'lexical-only' when ≤2 survivors", async () => {
    const items: RecallItem[] = [
      { id: "a", text: "database connection" },
      { id: "b", text: "unrelated topic" },
    ];
    const scorer = createStubScorer({
      a: { score: 0.9, reason: "relevant" },
    });
    const result = await filterRecall(items, mockContext, scorer);
    // Only 1 survivor, so stage 2 skipped
    expect(result.every((r) => r.reason === "lexical-only")).toBe(true);
  });
});

// ── filterRecall stage 2 tests ─────────────────────────────────────────────

describe("filterRecall stage 2", () => {
  it("calls scorer when >2 survivors", async () => {
    const baseScorer = createStubScorer({
      "item-1": { score: 0.9, reason: "relevant" },
      "item-2": { score: 0.5, reason: "marginal" },
      "item-4": { score: 0.8, reason: "relevant" },
    });
    const scorer = vi.fn(baseScorer);
    await filterRecall(mockItems, mockContext, scorer);
    expect(scorer).toHaveBeenCalled();
  });

  it("keeps items with score >= threshold (default 0.6)", async () => {
    const scorer = createStubScorer({
      "item-1": { score: 0.9, reason: "relevant" },
      "item-2": { score: 0.5, reason: "too low" },
      "item-4": { score: 0.6, reason: "exactly threshold" },
    });
    const result = await filterRecall(mockItems, mockContext, scorer);
    expect(result.some((r) => r.item.id === "item-1")).toBe(true);
    expect(result.some((r) => r.item.id === "item-4")).toBe(true);
    // item-2 has score 0.5 < 0.6, so should be dropped
    expect(result.some((r) => r.item.id === "item-2")).toBe(false);
  });

  it("respects custom threshold", async () => {
    const scorer = createStubScorer({
      "item-1": { score: 0.8, reason: "good" },
      "item-4": { score: 0.7, reason: "okay" },
    });
    const result = await filterRecall(mockItems, mockContext, scorer, {
      threshold: 0.75,
    });
    expect(result.some((r) => r.item.id === "item-1")).toBe(true);
    expect(result.some((r) => r.item.id === "item-4")).toBe(false);
  });

  it("treats missing items in scorer response as score 0 (dropped)", async () => {
    const scorer = createStubScorer({
      "item-1": { score: 0.9, reason: "relevant" },
      // item-4 not in response
    });
    const result = await filterRecall(mockItems, mockContext, scorer);
    expect(result.some((r) => r.item.id === "item-1")).toBe(true);
    expect(result.some((r) => r.item.id === "item-4")).toBe(false);
  });

  it("falls back to stage-1 survivors when scorer throws", async () => {
    const scorer = createThrowingScorer();
    const result = await filterRecall(mockItems, mockContext, scorer);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.score === -1)).toBe(true);
    expect(result.every((r) => r.reason === "scorer-unavailable")).toBe(true);
  });
});

// ── Result ordering tests ──────────────────────────────────────────────────

describe("filterRecall result ordering", () => {
  it("sorts by score descending", async () => {
    const scorer = createStubScorer({
      "item-1": { score: 0.9, reason: "high" },
      "item-2": { score: 0.8, reason: "medium" },
      "item-4": { score: 0.7, reason: "low" },
    });
    const result = await filterRecall(mockItems, mockContext, scorer);
    const scores = result.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      const current = scores[i];
      const prev = scores[i - 1];
      if (current !== undefined && prev !== undefined) {
        expect(current).toBeLessThanOrEqual(prev);
      }
    }
  });

  it("preserves original order on score ties", async () => {
    const items: RecallItem[] = [
      { id: "a", text: "database connection" },
      { id: "b", text: "database timeout" },
      { id: "c", text: "connection issue" },
    ];
    const scorer = createStubScorer({
      a: { score: 0.8, reason: "tied" },
      b: { score: 0.8, reason: "tied" },
      c: { score: 0.8, reason: "tied" },
    });
    const result = await filterRecall(items, mockContext, scorer);
    // All have same score; should preserve order
    expect(result[0]?.item.id).toBe("a");
    expect(result[1]?.item.id).toBe("b");
    expect(result[2]?.item.id).toBe("c");
  });

  it("every returned item has a non-empty reason", async () => {
    const scorer = createStubScorer({
      "item-1": { score: 0.9, reason: "relevant" },
      "item-4": { score: 0.8, reason: "related" },
    });
    const result = await filterRecall(mockItems, mockContext, scorer);
    expect(result.every((r) => r.reason && r.reason.length > 0)).toBe(true);
  });
});

// ── tagRecall tests ────────────────────────────────────────────────────────

describe("tagRecall", () => {
  it("returns empty string for empty input", () => {
    const result = tagRecall([]);
    expect(result).toBe("");
  });

  it("renders items as markdown block with title", () => {
    const items: ScoredRecall[] = [
      {
        item: { id: "a", text: "database connection timeout" },
        score: 0.9,
        reason: "relevant",
      },
    ];
    const result = tagRecall(items);
    expect(result).toContain("## Lessons from prior sessions (filtered)");
    expect(result).toContain("- [recall — verify before trusting]");
  });

  it("includes item text in each line", () => {
    const items: ScoredRecall[] = [
      {
        item: { id: "a", text: "database connection timeout issue" },
        score: 0.9,
        reason: "relevant",
      },
    ];
    const result = tagRecall(items);
    expect(result).toContain("database connection timeout issue");
  });

  it("collapses whitespace to single lines", () => {
    const items: ScoredRecall[] = [
      {
        item: {
          id: "a",
          text: "database\n\nconnection\t\ttimeout\n\nissue",
        },
        score: 0.9,
        reason: "relevant",
      },
    ];
    const result = tagRecall(items);
    expect(result).toContain("database connection timeout issue");
    expect(result).not.toContain("\n\n");
  });

  it("caps each line at 300 chars", () => {
    const longText = "a".repeat(400);
    const items: ScoredRecall[] = [
      {
        item: { id: "a", text: longText },
        score: 0.9,
        reason: "relevant",
      },
    ];
    const result = tagRecall(items);
    const lines = result.split("\n");
    // Find the line with the item text (not the title)
    const contentLine = lines.find((l) => l.includes("recall — verify"));
    expect(contentLine).toBeDefined();
    if (contentLine) {
      expect(contentLine.length).toBeLessThanOrEqual(300 + 50); // 300 chars + markup overhead
    }
  });

  it("adds ellipsis when truncating", () => {
    const longText = "a".repeat(350);
    const items: ScoredRecall[] = [
      {
        item: { id: "a", text: longText },
        score: 0.9,
        reason: "relevant",
      },
    ];
    const result = tagRecall(items);
    expect(result).toContain("...");
  });

  it("renders multiple items with newlines", () => {
    const items: ScoredRecall[] = [
      {
        item: { id: "a", text: "first item about database" },
        score: 0.9,
        reason: "relevant",
      },
      {
        item: { id: "b", text: "second item about connection" },
        score: 0.8,
        reason: "related",
      },
    ];
    const result = tagRecall(items);
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3); // title + 2 items
    expect(result).toContain("first item");
    expect(result).toContain("second item");
  });
});

// ── Integration tests ──────────────────────────────────────────────────────

describe("filterRecall integration", () => {
  it("end-to-end: stage 1 → stage 2 → result ordering", async () => {
    const items: RecallItem[] = [
      { id: "a", text: "database connection pooling" },
      { id: "b", text: "unrelated CSS styling" },
      { id: "c", text: "database timeout configuration" },
      { id: "d", text: "another unrelated topic" },
      { id: "e", text: "database query optimization" },
    ];
    const scorer = createStubScorer({
      a: { score: 0.95, reason: "highly relevant" },
      c: { score: 0.75, reason: "somewhat relevant" },
      e: { score: 0.55, reason: "marginally relevant" },
    });
    const result = await filterRecall(items, mockContext, scorer, {
      threshold: 0.6,
    });
    // b and d should be dropped in stage 1 (no overlap)
    // e should be dropped in stage 2 (score 0.55 < 0.6)
    // a and c should survive and be sorted by score (0.95 > 0.75)
    expect(result.length).toBe(2);
    expect(result[0]?.item.id).toBe("a");
    expect(result[1]?.item.id).toBe("c");
  });

  it("handles empty input", async () => {
    const result = await filterRecall([], mockContext);
    expect(result).toEqual([]);
  });

  it("handles single item", async () => {
    const items: RecallItem[] = [{ id: "a", text: "database connection" }];
    const result = await filterRecall(items, mockContext);
    expect(result.length).toBe(1);
  });

  it("scorer receives correct context", async () => {
    const baseScorer = async (
      items: RecallItem[],
      context: TaskContext,
    ): Promise<Array<{ id: string; score: number; reason: string }>> => {
      expect(context.issue).toBe(mockContext.issue);
      expect(context.candidateFiles).toEqual(mockContext.candidateFiles);
      return items.map((item) => ({
        id: item.id,
        score: 0.8,
        reason: "verified",
      }));
    };
    const scorer = vi.fn(baseScorer);
    await filterRecall(mockItems, mockContext, scorer);
    expect(scorer).toHaveBeenCalled();
  });
});
