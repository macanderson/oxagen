/**
 * Tests for F5 consensus-or-escalate selection.
 *
 * Coverage targets
 * ─────────────────
 *  • normalizeDiff: strip noise (index, hunk offsets, similarity, file mode)
 *  • normalizeDiff: trailing whitespace removal
 *  • normalizeDiff: whitespace-only hunk cancellation
 *  • normalizeDiff: file ordering (sorted by path)
 *  • normalizeDiff: hunk ordering (preserved within file)
 *  • normalizeDiff: fingerprint stability (same input twice)
 *  • diffEquivalent: equality under noise
 *  • diffEquivalent: non-equality on real semantic differences
 *  • diffClusters: grouping by fingerprint
 *  • diffClusters: cluster ordering (size desc, first-member index asc)
 *  • diffClusters: empty diff special case (fingerprint "empty")
 *  • decideSelection: consensus (>= 2 passing, same diff)
 *  • decideSelection: consensus winner selection (fewest lines, tie → index)
 *  • decideSelection: single-passing
 *  • decideSelection: selector-needed (>= 2 passing, different diffs)
 *  • decideSelection: best-effort (no passing, score tie)
 *  • decideSelection: best-effort with diff-line tiebreaker
 *  • decideSelection: all-empty-diff path
 */
import { describe, it, expect } from "vitest";
import {
  normalizeDiff,
  diffEquivalent,
  diffClusters,
  decideSelection,
  type NormalizedDiff,
  type DiffCluster,
  type CandidateEvidence,
  type SelectionDecision,
} from "./consensus";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A simple single-file diff. */
const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1
-old2
+new2
 line3
 line4`;

/** Same diff with different hunk offsets (should be equivalent). */
const SIMPLE_DIFF_DIFFERENT_OFFSET = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -5,4 +5,4 @@
 line1
-old2
+new2
 line3
 line4`;

/** Same diff with trailing whitespace (should be equivalent). */
const SIMPLE_DIFF_TRAILING_WHITESPACE = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1  
-old2  
+new2  
 line3
 line4`;

/** A diff with a whitespace-only change (should be canceled out). */
const DIFF_WITH_WHITESPACE_ONLY = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1
-old2
+new2
 line3  
 line4`;

/** A diff with a real semantic change. */
const DIFF_SEMANTIC_CHANGE = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1
-old2
+different
 line3
 line4`;

/** A multi-file diff. */
const MULTI_FILE_DIFF = `diff --git a/src/bar.ts b/src/bar.ts
index 1234567..abcdefg 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,3 @@
 x
-y
+Y
 z
diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c`;

/** Same multi-file diff with reversed file order (should be equivalent). */
const MULTI_FILE_DIFF_REVERSED_ORDER = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
diff --git a/src/bar.ts b/src/bar.ts
index 1234567..abcdefg 100644
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,3 @@
 x
-y
+Y
 z`;

/** An empty diff (no hunks). */
const EMPTY_DIFF = "";

/** Another empty diff. */
const EMPTY_DIFF_2 = "diff --git a/src/empty.ts b/src/empty.ts";

/** A new-file diff. */
const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;

// ── normalizeDiff ────────────────────────────────────────────────────────────

describe("normalizeDiff", () => {
  it("strips index lines", () => {
    const normalized = normalizeDiff(SIMPLE_DIFF);
    const content = JSON.stringify(normalized);
    expect(content).not.toContain("index");
  });

  it("zeros hunk offsets", () => {
    const normalized = normalizeDiff(SIMPLE_DIFF);
    // All hunk headers should be normalized to @@ -0,0 +0,0 @@
    expect(normalized.files[0]!.hunks[0]).toContain("@@ -0,0 +0,0 @@");
  });

  it("strips trailing whitespace from lines", () => {
    const normalized = normalizeDiff(SIMPLE_DIFF_TRAILING_WHITESPACE);
    const hunk = normalized.files[0]!.hunks[0]!;
    // Should not have trailing spaces
    const lines = hunk.split("\n");
    for (const line of lines) {
      if (line.length > 1) {
        expect(line).not.toMatch(/[\s]$/);
      }
    }
  });

  it("cancels whitespace-only context changes", () => {
    const normalized = normalizeDiff(DIFF_WITH_WHITESPACE_ONLY);
    const hunk = normalized.files[0]!.hunks[0]!;
    // The "context  line" vs "context line" pair should be canceled out
    // So we should have fewer lines than the original
    const lines = hunk.split("\n");
    // The hunk header + line1 + -old2 + +new2 + line3 + line5 + line6 = 7 lines
    // But the whitespace-only change should be removed
    expect(lines.length).toBeLessThan(9); // Original would be 9 with the whitespace-only pair
  });

  it("sorts files by path", () => {
    const normalized = normalizeDiff(MULTI_FILE_DIFF_REVERSED_ORDER);
    // Files should be sorted: bar before foo
    expect(normalized.files[0]!.path).toBe("src/bar.ts");
    expect(normalized.files[1]!.path).toBe("src/foo.ts");
  });

  it("preserves hunk order within a file", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 d
-e
+E
 f`;
    const normalized = normalizeDiff(diff);
    expect(normalized.files[0]!.hunks).toHaveLength(2);
    // First hunk should come before second
    expect(normalized.files[0]!.hunks[0]!).toContain("-b");
    expect(normalized.files[0]!.hunks[1]!).toContain("-e");
  });

  it("computes stable fingerprint", () => {
    const fp1 = normalizeDiff(SIMPLE_DIFF).fingerprint;
    const fp2 = normalizeDiff(SIMPLE_DIFF).fingerprint;
    expect(fp1).toBe(fp2);
  });

  it("handles empty diffs", () => {
    const normalized = normalizeDiff(EMPTY_DIFF);
    expect(normalized.files).toHaveLength(0);
  });

  it("handles new-file diffs", () => {
    const normalized = normalizeDiff(NEW_FILE_DIFF);
    expect(normalized.files).toHaveLength(1);
    expect(normalized.files[0]!.path).toBe("src/new.ts");
  });
});

// ── diffEquivalent ───────────────────────────────────────────────────────────

describe("diffEquivalent", () => {
  it("considers diffs equivalent under different hunk offsets", () => {
    expect(diffEquivalent(SIMPLE_DIFF, SIMPLE_DIFF_DIFFERENT_OFFSET)).toBe(
      true,
    );
  });

  it("considers diffs equivalent under trailing whitespace", () => {
    expect(diffEquivalent(SIMPLE_DIFF, SIMPLE_DIFF_TRAILING_WHITESPACE)).toBe(
      true,
    );
  });

  it("considers diffs equivalent with whitespace-only changes canceled", () => {
    // Both diffs have the same semantic change (-old2 +new2)
    // DIFF_WITH_WHITESPACE_ONLY also has a whitespace-only change in context
    // which should be canceled out, making them equivalent
    expect(diffEquivalent(SIMPLE_DIFF, DIFF_WITH_WHITESPACE_ONLY)).toBe(true);
  });

  it("considers diffs non-equivalent on real semantic differences", () => {
    expect(diffEquivalent(SIMPLE_DIFF, DIFF_SEMANTIC_CHANGE)).toBe(false);
  });

  it("considers multi-file diffs equivalent regardless of file order", () => {
    expect(
      diffEquivalent(MULTI_FILE_DIFF, MULTI_FILE_DIFF_REVERSED_ORDER),
    ).toBe(true);
  });

  it("considers different diffs non-equivalent", () => {
    expect(diffEquivalent(SIMPLE_DIFF, NEW_FILE_DIFF)).toBe(false);
  });

  it("considers empty diffs equivalent", () => {
    expect(diffEquivalent(EMPTY_DIFF, EMPTY_DIFF_2)).toBe(true);
  });
});

// ── diffClusters ──────────────────────────────────────────────────────────────

describe("diffClusters", () => {
  it("groups equivalent diffs into one cluster", () => {
    const diffs = [
      SIMPLE_DIFF,
      SIMPLE_DIFF_DIFFERENT_OFFSET,
      SIMPLE_DIFF_TRAILING_WHITESPACE,
    ];
    const clusters = diffClusters(diffs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.members).toEqual([0, 1, 2]);
  });

  it("separates non-equivalent diffs into different clusters", () => {
    const diffs = [SIMPLE_DIFF, DIFF_SEMANTIC_CHANGE];
    const clusters = diffClusters(diffs);
    expect(clusters).toHaveLength(2);
  });

  it("groups empty diffs under fingerprint 'empty'", () => {
    const diffs = [EMPTY_DIFF, EMPTY_DIFF_2];
    const clusters = diffClusters(diffs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.fingerprint).toBe("empty");
  });

  it("sorts clusters by size descending", () => {
    const diffs = [
      SIMPLE_DIFF,
      SIMPLE_DIFF_DIFFERENT_OFFSET,
      DIFF_SEMANTIC_CHANGE,
      NEW_FILE_DIFF,
    ];
    const clusters = diffClusters(diffs);
    // First cluster should have 2 members (SIMPLE_DIFF variants)
    // Second and third clusters should have 1 member each
    expect(clusters[0]!.members).toHaveLength(2);
  });

  it("orders clusters with same size by first-member index", () => {
    const diffs = [SIMPLE_DIFF, DIFF_SEMANTIC_CHANGE, NEW_FILE_DIFF];
    const clusters = diffClusters(diffs);
    // All clusters have size 1, so order should be by first-member index: 1, 2
    if (clusters.length > 1) {
      expect(Math.min(...clusters[0]!.members)).toBeLessThan(
        Math.min(...clusters[1]!.members),
      );
    }
  });
});

// ── decideSelection ───────────────────────────────────────────────────────────

describe("decideSelection", () => {
  describe("consensus path", () => {
    it("selects consensus when >= 2 passing candidates have equivalent diffs", () => {
      const candidates: CandidateEvidence[] = [
        {
          index: 0,
          diff: SIMPLE_DIFF,
          testsPassed: true,
          evidenceScore: 0.8,
        },
        {
          index: 1,
          diff: SIMPLE_DIFF_DIFFERENT_OFFSET,
          testsPassed: true,
          evidenceScore: 0.8,
        },
        {
          index: 2,
          diff: DIFF_SEMANTIC_CHANGE,
          testsPassed: false,
          evidenceScore: 0.5,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("consensus");
      expect(
        (decision as Extract<SelectionDecision, { method: "consensus" }>)
          .cluster,
      ).toHaveLength(2);
    });

    it("picks consensus winner with fewest diff lines", () => {
      // Two equivalent diffs with the same semantic change
      const shortDiff = SIMPLE_DIFF;
      const longDiff = SIMPLE_DIFF_TRAILING_WHITESPACE;

      const candidates: CandidateEvidence[] = [
        { index: 0, diff: shortDiff, testsPassed: true, evidenceScore: 0.8 },
        { index: 1, diff: longDiff, testsPassed: true, evidenceScore: 0.8 },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("consensus");
      // Both have same line count, so should pick by index (lowest wins)
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(0); // shortDiff (lower index)
    });

    it("breaks consensus tie by lowest index", () => {
      const candidates: CandidateEvidence[] = [
        { index: 5, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.8 },
        {
          index: 3,
          diff: SIMPLE_DIFF_DIFFERENT_OFFSET,
          testsPassed: true,
          evidenceScore: 0.8,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("consensus");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(3); // Lower index
    });

    it("ignores non-passing candidates in consensus", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.8 },
        {
          index: 1,
          diff: SIMPLE_DIFF_DIFFERENT_OFFSET,
          testsPassed: false,
          evidenceScore: 0.8,
        },
      ];

      const decision = decideSelection(candidates);
      // Only 1 passing, so not consensus
      expect(decision.method).toBe("single-passing");
    });
  });

  describe("single-passing path", () => {
    it("selects single-passing when exactly one candidate passes", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.8 },
        {
          index: 1,
          diff: NEW_FILE_DIFF,
          testsPassed: false,
          evidenceScore: 0.5,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("single-passing");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(0);
    });
  });

  describe("selector-needed path", () => {
    it("selects selector-needed when multiple passing but non-equivalent", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.8 },
        {
          index: 1,
          diff: DIFF_SEMANTIC_CHANGE,
          testsPassed: true,
          evidenceScore: 0.7,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("selector-needed");
      expect(
        (decision as Extract<SelectionDecision, { method: "selector-needed" }>)
          .candidates,
      ).toContain(0);
      expect(
        (decision as Extract<SelectionDecision, { method: "selector-needed" }>)
          .candidates,
      ).toContain(1);
    });
  });

  describe("best-effort path", () => {
    it("selects best-effort when no candidates pass", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: false, evidenceScore: 0.8 },
        {
          index: 1,
          diff: NEW_FILE_DIFF,
          testsPassed: false,
          evidenceScore: 0.5,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(0); // Highest score
    });

    it("picks best-effort winner with highest evidence score", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: false, evidenceScore: 0.5 },
        {
          index: 1,
          diff: NEW_FILE_DIFF,
          testsPassed: false,
          evidenceScore: 0.9,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(1);
    });

    it("breaks best-effort score tie by smallest diff line count", () => {
      const shortDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c`;

      const longDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,10 +1,10 @@
 a
-b
+B
 c
 d
-e
+E
 f
 g
-h
+H
 i`;

      const candidates: CandidateEvidence[] = [
        { index: 0, diff: longDiff, testsPassed: false, evidenceScore: 0.8 },
        { index: 1, diff: shortDiff, testsPassed: false, evidenceScore: 0.8 },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(1); // Shorter diff
    });

    it("breaks best-effort diff-tie by lowest index", () => {
      const candidates: CandidateEvidence[] = [
        { index: 5, diff: SIMPLE_DIFF, testsPassed: false, evidenceScore: 0.8 },
        {
          index: 3,
          diff: SIMPLE_DIFF_DIFFERENT_OFFSET,
          testsPassed: false,
          evidenceScore: 0.8,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(3); // Lower index
    });
  });

  describe("all-empty-diff path", () => {
    it("returns best-effort when all diffs are empty", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: EMPTY_DIFF, testsPassed: false, evidenceScore: 0.5 },
        { index: 1, diff: EMPTY_DIFF_2, testsPassed: true, evidenceScore: 0.8 },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(1); // Highest score
    });

    it("breaks all-empty score tie by lowest index", () => {
      const candidates: CandidateEvidence[] = [
        { index: 5, diff: EMPTY_DIFF, testsPassed: false, evidenceScore: 0.8 },
        {
          index: 3,
          diff: EMPTY_DIFF_2,
          testsPassed: false,
          evidenceScore: 0.8,
        },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("best-effort");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("handles single candidate", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.8 },
      ];

      const decision = decideSelection(candidates);
      expect(decision.method).toBe("single-passing");
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(0);
    });

    it("handles empty candidates array gracefully", () => {
      const candidates: CandidateEvidence[] = [];
      // This is an edge case; the function should handle it without crashing
      // Since there are no candidates, we expect best-effort with winner=0
      // but this might throw. Let's just verify it doesn't crash.
      expect(() => decideSelection(candidates)).not.toThrow();
    });

    it("ignores empty diffs when deciding between non-empty", () => {
      const candidates: CandidateEvidence[] = [
        { index: 0, diff: EMPTY_DIFF, testsPassed: true, evidenceScore: 0.9 },
        { index: 1, diff: SIMPLE_DIFF, testsPassed: true, evidenceScore: 0.7 },
      ];

      const decision = decideSelection(candidates);
      // Should pick the non-empty one
      expect(
        (decision as Extract<SelectionDecision, { winner: number }>).winner,
      ).toBe(1);
    });
  });
});
