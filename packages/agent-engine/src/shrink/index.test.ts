/**
 * Tests for the F6 deterministic diff shrinker.
 *
 * Coverage targets
 * ─────────────────
 *  • parsePatch / renderPatch round-trip (multi-file, new-file, delete, rename)
 *  • shrink: independent hunks (all droppable)
 *  • shrink: dependent pair (neither alone droppable, both required together)
 *  • shrink: all hunks required (nothing can be dropped)
 *  • shrink: maxOracleRuns budget cap
 *  • shrink: hunks ≤ 2 skip (returns original immediately, oracleRuns=0)
 *  • shrink: protectedPaths never dropped
 *  • shrink: oracle throws → fallback to original (never-worse guarantee)
 *  • ShrinkResult shape (dropped + kept + oracleRuns + reduced)
 */
import { describe, it, expect, vi } from "vitest";
import { parsePatch, renderPatch, shrink } from "./index";
import type { Hunk, ShrinkResult } from "./index";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** A simple two-hunk single-file diff. */
const SIMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,4 @@
 line1
-old2
+new2
 line3
 line4
@@ -10,4 +10,4 @@
 line10
-old11
+new11
 line12
 line13`;

/** A two-file diff (three hunks total). */
const MULTI_FILE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,3 +1,3 @@
 x
-y
+Y
 z
@@ -10,3 +10,3 @@
 p
-q
+Q
 r`;

/** A new-file diff (git format). */
const NEW_FILE_DIFF = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;

/** A deleted-file diff (git format). */
const DELETE_FILE_DIFF = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line1
-line2
-line3`;

/** A rename diff (git format). */
const RENAME_DIFF = `diff --git a/src/before.ts b/src/after.ts
rename from src/before.ts
rename to src/after.ts
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,3 +1,3 @@
 keep
-remove
+add
 end`;

/** A three-hunk single-file diff for greedy tests. */
const THREE_HUNK_DIFF = `diff --git a/src/target.ts b/src/target.ts
--- a/src/target.ts
+++ b/src/target.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 d
-e
+E
 f
@@ -20,3 +20,3 @@
 g
-h
+H
 i`;

// ── parsePatch ────────────────────────────────────────────────────────────────

describe("parsePatch", () => {
  it("parses a single-file two-hunk diff into two Hunk objects", () => {
    const hunks = parsePatch(SIMPLE_DIFF);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.filePath).toBe("src/foo.ts");
    expect(hunks[1]!.filePath).toBe("src/foo.ts");
    expect(hunks[0]!.hunkIndex).toBe(0);
    expect(hunks[1]!.hunkIndex).toBe(1);
    expect(hunks[0]!.raw).toContain("@@ -1,4 +1,4 @@");
    expect(hunks[1]!.raw).toContain("@@ -10,4 +10,4 @@");
    // Both hunks share the same fileHeader
    expect(hunks[0]!.fileHeader).toBe(hunks[1]!.fileHeader);
  });

  it("parses a multi-file diff: correct filePaths and hunk counts", () => {
    const hunks = parsePatch(MULTI_FILE_DIFF);
    expect(hunks).toHaveLength(3);
    expect(hunks[0]!.filePath).toBe("src/foo.ts");
    expect(hunks[1]!.filePath).toBe("src/bar.ts");
    expect(hunks[2]!.filePath).toBe("src/bar.ts");
    // foo and bar have different fileHeaders
    expect(hunks[0]!.fileHeader).not.toBe(hunks[1]!.fileHeader);
    // bar's two hunks share a fileHeader
    expect(hunks[1]!.fileHeader).toBe(hunks[2]!.fileHeader);
  });

  it("parses a new-file diff: filePath derived from +++ line", () => {
    const hunks = parsePatch(NEW_FILE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.filePath).toBe("src/new.ts");
    expect(hunks[0]!.toPath).toBe("b/src/new.ts");
    expect(hunks[0]!.raw).toContain("+line1");
  });

  it("parses a deleted-file diff: filePath derived from --- line", () => {
    const hunks = parsePatch(DELETE_FILE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.filePath).toBe("src/old.ts");
    expect(hunks[0]!.raw).toContain("-line1");
  });

  it("parses a rename diff: filePath is the rename-to target", () => {
    const hunks = parsePatch(RENAME_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.filePath).toBe("src/after.ts");
    expect(hunks[0]!.raw).toContain("+add");
  });

  it("returns an empty array for an empty diff string", () => {
    expect(parsePatch("")).toHaveLength(0);
  });

  it("returns an empty array for a diff with no hunk lines (binary file entry)", () => {
    const binaryDiff = `diff --git a/image.png b/image.png
index abc..def 100644
Binary files a/image.png and b/image.png differ`;
    expect(parsePatch(binaryDiff)).toHaveLength(0);
  });
});

// ── renderPatch ───────────────────────────────────────────────────────────────

describe("renderPatch", () => {
  it("renders an empty array as an empty string", () => {
    expect(renderPatch([])).toBe("");
  });

  it("round-trips a simple diff: parse → render produces an equivalent patch", () => {
    const hunks = parsePatch(SIMPLE_DIFF);
    const rendered = renderPatch(hunks);
    // Both hunks must be present
    expect(rendered).toContain("@@ -1,4 +1,4 @@");
    expect(rendered).toContain("@@ -10,4 +10,4 @@");
    expect(rendered).toContain("+new2");
    expect(rendered).toContain("+new11");
    // The file header appears exactly once
    const headerCount = (rendered.match(/diff --git/g) ?? []).length;
    expect(headerCount).toBe(1);
  });

  it("round-trips a multi-file diff", () => {
    const hunks = parsePatch(MULTI_FILE_DIFF);
    const rendered = renderPatch(hunks);
    expect(rendered).toContain("src/foo.ts");
    expect(rendered).toContain("src/bar.ts");
    const headerCount = (rendered.match(/diff --git/g) ?? []).length;
    expect(headerCount).toBe(2);
  });

  it("round-trips a new-file diff", () => {
    const hunks = parsePatch(NEW_FILE_DIFF);
    const rendered = renderPatch(hunks);
    expect(rendered).toContain("new file mode");
    expect(rendered).toContain("+line1");
  });

  it("round-trips a deleted-file diff", () => {
    const hunks = parsePatch(DELETE_FILE_DIFF);
    const rendered = renderPatch(hunks);
    expect(rendered).toContain("deleted file mode");
    expect(rendered).toContain("-line1");
  });

  it("round-trips a rename diff", () => {
    const hunks = parsePatch(RENAME_DIFF);
    const rendered = renderPatch(hunks);
    expect(rendered).toContain("rename from");
    expect(rendered).toContain("rename to");
    expect(rendered).toContain("+add");
  });

  it("groups multiple hunks from the same file under one header", () => {
    const hunks = parsePatch(SIMPLE_DIFF);
    const rendered = renderPatch(hunks);
    // Only one "diff --git" line even though there are two hunks
    expect((rendered.match(/diff --git/g) ?? []).length).toBe(1);
  });

  it("renders a subset of hunks (only kept hunks appear)", () => {
    const hunks = parsePatch(MULTI_FILE_DIFF);
    // Keep only the bar.ts hunks
    const barHunks = hunks.filter((h) => h.filePath === "src/bar.ts");
    const rendered = renderPatch(barHunks);
    expect(rendered).not.toContain("src/foo.ts");
    expect(rendered).toContain("src/bar.ts");
    expect(rendered).toContain("+Y");
    expect(rendered).toContain("+Q");
  });
});

// ── shrink: hunks ≤ 2 skip ────────────────────────────────────────────────────

describe("shrink — hunks ≤ 2 skip", () => {
  it("returns original unchanged with reduced:false and oracleRuns:0 for a one-hunk diff", async () => {
    const oracle = vi.fn(async () => true);
    const result = await shrink(NEW_FILE_DIFF, oracle);
    expect(result.reduced).toBe(false);
    expect(result.oracleRuns).toBe(0);
    expect(result.patch).toBe(NEW_FILE_DIFF);
    expect(oracle).not.toHaveBeenCalled();
  });

  it("returns original unchanged with reduced:false and oracleRuns:0 for a two-hunk diff", async () => {
    const oracle = vi.fn(async () => true);
    const result = await shrink(SIMPLE_DIFF, oracle);
    expect(result.reduced).toBe(false);
    expect(result.oracleRuns).toBe(0);
    expect(result.patch).toBe(SIMPLE_DIFF);
    expect(oracle).not.toHaveBeenCalled();
  });
});

// ── shrink: all hunks independent (all droppable) ─────────────────────────────

describe("shrink — independent hunks (all droppable)", () => {
  it("drops all but one hunk when every subset passes the oracle", async () => {
    // Oracle always returns true — any reduction is valid.
    const oracle = vi.fn(async () => true);
    const result = await shrink(THREE_HUNK_DIFF, oracle);

    // At minimum one hunk must remain (renderPatch on empty is guarded, but
    // shrink never produces an empty patch — so kept ≥ 1).
    expect(result.kept).toBeGreaterThanOrEqual(1);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.reduced).toBe(true);
    expect(result.oracleRuns).toBeGreaterThan(0);
    // The returned patch must contain at least one @@ line
    expect(result.patch).toContain("@@");
  });

  it("drops hunks from multiple files when oracle always passes", async () => {
    const oracle = vi.fn(async () => true);
    const result = await shrink(MULTI_FILE_DIFF, oracle);
    expect(result.reduced).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.kept).toBeGreaterThanOrEqual(1);
  });
});

// ── shrink: dependent pair ─────────────────────────────────────────────────────

describe("shrink — dependent pair (neither alone droppable)", () => {
  it("keeps both hunks of a pair when dropping either one fails the oracle", async () => {
    // THREE_HUNK_DIFF has hunks H0, H1, H2.
    // Oracle: passes only when ALL three are present, or when exactly H2 is dropped
    // (i.e. H0 + H1 are required together, H2 is droppable).
    const hunks = parsePatch(THREE_HUNK_DIFF);
    const [h0, h1] = [hunks[0]!, hunks[1]!];

    const oracle = vi.fn(async (candidate: string) => {
      const ch = parsePatch(candidate);
      // Must contain both h0 and h1 (identified by their raw text)
      const hasH0 = ch.some((h) => h.raw === h0.raw);
      const hasH1 = ch.some((h) => h.raw === h1.raw);
      return hasH0 && hasH1;
    });

    const result = await shrink(THREE_HUNK_DIFF, oracle);

    // H0 and H1 must be present; H2 may be dropped
    const keptHunks = parsePatch(result.patch);
    expect(keptHunks.some((h) => h.raw === h0.raw)).toBe(true);
    expect(keptHunks.some((h) => h.raw === h1.raw)).toBe(true);
    expect(result.reduced).toBe(true); // H2 was dropped
    expect(result.dropped).toBe(1);
  });
});

// ── shrink: all hunks required ────────────────────────────────────────────────

describe("shrink — all hunks required", () => {
  it("returns original patch when every reduction fails the oracle", async () => {
    // Oracle only passes when all three hunks are present.
    const hunks = parsePatch(THREE_HUNK_DIFF);
    const oracle = vi.fn(async (candidate: string) => {
      return parsePatch(candidate).length === hunks.length;
    });

    const result = await shrink(THREE_HUNK_DIFF, oracle);
    expect(result.reduced).toBe(false);
    expect(result.dropped).toBe(0);
    expect(result.kept).toBe(hunks.length);
    // patch content is equivalent to original
    expect(parsePatch(result.patch)).toHaveLength(hunks.length);
  });
});

// ── shrink: maxOracleRuns budget cap ──────────────────────────────────────────

describe("shrink — maxOracleRuns budget cap", () => {
  it("never exceeds maxOracleRuns oracle invocations", async () => {
    // Oracle always returns false so we exercise the full budget without any
    // successful drops.
    const oracle = vi.fn(async () => false);
    const result = await shrink(THREE_HUNK_DIFF, oracle, { maxOracleRuns: 2 });
    expect(result.oracleRuns).toBeLessThanOrEqual(2);
  });

  it("stops early and returns last-known-green when budget is exhausted mid-run", async () => {
    // Use a five-hunk diff so there's plenty to try.
    const fiveHunkDiff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,3 @@
 d
-e
+E
 f
@@ -20,3 +20,3 @@
 g
-h
+H
 i
@@ -30,3 +30,3 @@
 j
-k
+K
 l
@@ -40,3 +40,3 @@
 m
-n
+N
 o`;

    // Oracle always returns true — any reduction is valid.
    const oracle = vi.fn(async () => true);
    const result = await shrink(fiveHunkDiff, oracle, { maxOracleRuns: 3 });
    expect(result.oracleRuns).toBeLessThanOrEqual(3);
    // Should still have reduced something (budget allows at least 3 drops)
    expect(result.reduced).toBe(true);
  });
});

// ── shrink: protectedPaths never dropped ──────────────────────────────────────

describe("shrink — protectedPaths never dropped", () => {
  it("never drops a hunk whose filePath is in protectedPaths", async () => {
    // Oracle always returns true — without protection, everything would be dropped.
    const oracle = vi.fn(async () => true);
    const result = await shrink(MULTI_FILE_DIFF, oracle, {
      protectedPaths: ["src/foo.ts"],
    });

    const keptHunks = parsePatch(result.patch);
    // foo.ts hunk must still be present
    expect(keptHunks.some((h) => h.filePath === "src/foo.ts")).toBe(true);
  });

  it("can still drop unprotected hunks when some paths are protected", async () => {
    const oracle = vi.fn(async () => true);
    const result = await shrink(MULTI_FILE_DIFF, oracle, {
      protectedPaths: ["src/foo.ts"],
    });

    const keptHunks = parsePatch(result.patch);
    // foo.ts is protected — must be kept
    expect(keptHunks.some((h) => h.filePath === "src/foo.ts")).toBe(true);
    // bar.ts hunks may have been dropped (oracle always passes)
    // At minimum we reduced something
    const allHunks = parsePatch(MULTI_FILE_DIFF);
    expect(result.kept).toBeLessThan(allHunks.length);
  });

  it("protects hunks matched by fromPath or toPath as well", async () => {
    // The rename diff has fromPath "src/before.ts" and toPath "src/after.ts".
    // Protect by the old name.
    // Use a diff with 3+ hunks: rename hunk + two others.
    const mixed = `diff --git a/src/before.ts b/src/after.ts
rename from src/before.ts
rename to src/after.ts
--- a/src/before.ts
+++ b/src/after.ts
@@ -1,3 +1,3 @@
 keep
-remove
+add
 end
diff --git a/src/extra.ts b/src/extra.ts
--- a/src/extra.ts
+++ b/src/extra.ts
@@ -1,3 +1,3 @@
 x
-y
+Y
 z
@@ -10,3 +10,3 @@
 p
-q
+Q
 r`;

    const oracle = vi.fn(async () => true);
    const result = await shrink(mixed, oracle, {
      protectedPaths: ["src/before.ts"],
    });

    const keptHunks = parsePatch(result.patch);
    // The rename hunk (fromPath contains "src/before.ts") must be kept
    expect(
      keptHunks.some(
        (h) => h.fromPath.includes("src/before.ts") || h.filePath === "src/after.ts",
      ),
    ).toBe(true);
  });
});

// ── shrink: oracle throws → never-worse guarantee ────────────────────────────

describe("shrink — oracle throws (never-worse guarantee)", () => {
  it("returns the original patch unchanged when every oracle call throws", async () => {
    const oracle = vi.fn(async () => {
      throw new Error("test harness unavailable");
    });

    const result = await shrink(THREE_HUNK_DIFF, oracle);
    // All oracle calls threw → no drop was accepted → original returned
    expect(result.reduced).toBe(false);
    expect(result.dropped).toBe(0);
    // patch is the original (content-equivalent)
    expect(parsePatch(result.patch)).toHaveLength(parsePatch(THREE_HUNK_DIFF).length);
  });

  it("returns the original when oracle throws on some calls and returns false on others", async () => {
    let callCount = 0;
    const oracle = vi.fn(async () => {
      callCount++;
      if (callCount % 2 === 0) throw new Error("flaky");
      return false;
    });

    const result = await shrink(THREE_HUNK_DIFF, oracle);
    expect(result.reduced).toBe(false);
    expect(result.dropped).toBe(0);
  });

  it("keeps a previously-accepted reduction when a later oracle call throws", async () => {
    // First call: drop file-level succeeds (returns true).
    // Subsequent calls: throw.
    // Result: first reduction is kept; later ones not attempted after throw.
    const hunks = parsePatch(MULTI_FILE_DIFF);
    let callCount = 0;
    const oracle = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return true; // first whole-file drop succeeds
      throw new Error("flaky after first call");
    });

    const result = await shrink(MULTI_FILE_DIFF, oracle);
    // At least one drop was accepted (the first oracle call returned true)
    expect(result.reduced).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
  });
});

// ── ShrinkResult shape ────────────────────────────────────────────────────────

describe("ShrinkResult shape", () => {
  it("dropped + kept === total hunks in original patch", async () => {
    const oracle = vi.fn(async () => true);
    const result: ShrinkResult = await shrink(THREE_HUNK_DIFF, oracle);
    const totalHunks = parsePatch(THREE_HUNK_DIFF).length;
    expect(result.dropped + result.kept).toBe(totalHunks);
  });

  it("reduced is true iff dropped > 0", async () => {
    // All-required oracle
    const oracle = vi.fn(async (c: string) => parsePatch(c).length === 3);
    const result = await shrink(THREE_HUNK_DIFF, oracle);
    expect(result.reduced).toBe(result.dropped > 0);
  });

  it("oracleRuns reflects actual number of oracle invocations", async () => {
    const oracle = vi.fn(async () => false);
    const result = await shrink(THREE_HUNK_DIFF, oracle);
    expect(result.oracleRuns).toBe(oracle.mock.calls.length);
  });
});
