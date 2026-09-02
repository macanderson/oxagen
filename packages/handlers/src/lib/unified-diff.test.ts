/**
 * Unit tests for the unified-diff helpers shared by agent.repo.edit and
 * repo.file.put — these produce the `diffs` output field that lights up the
 * chat code-diff card's full hunk view (parseUnifiedDiff in
 * apps/app/src/components/chat/registry-components/code-diff-card.tsx).
 */
import { describe, it, expect } from "vitest";
import { diffFileContents, splitCombinedDiff } from "./unified-diff";

describe("diffFileContents", () => {
  it("produces a real unified-diff patch with correct add/del counts for a modified file", () => {
    const result = diffFileContents(
      "src/a.ts",
      "export const a = 0;\n",
      "export const a = 1;\n",
    );

    expect(result.path).toBe("src/a.ts");
    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("--- a/src/a.ts");
    expect(result.patch).toContain("+++ b/src/a.ts");
    expect(result.patch).toContain("-export const a = 0;");
    expect(result.patch).toContain("+export const a = 1;");
  });

  it("treats an empty 'before' as a whole-file addition", () => {
    const result = diffFileContents("src/new.ts", "", "export const x = 1;\n");

    expect(result.additions).toBe(1);
    expect(result.deletions).toBe(0);
    expect(result.patch).toContain("+export const x = 1;");
  });

  it("treats an empty 'after' as a whole-file deletion", () => {
    const result = diffFileContents("src/gone.ts", "export const x = 1;\n", "");

    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(1);
    expect(result.patch).toContain("-export const x = 1;");
  });

  it("counts additions/deletions across multiple changed lines", () => {
    const before = "line 1\nline 2\nline 3\n";
    const after = "line 1\nline 2 changed\nline 3\nline 4\n";
    const result = diffFileContents("f.txt", before, after);

    // "line 2" -> "line 2 changed" is a 1-line remove + 1-line add; "line 4"
    // is a pure add.
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
  });

  it("produces an empty-hunk patch when content is identical", () => {
    const result = diffFileContents("same.ts", "x\n", "x\n");

    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });
});

describe("splitCombinedDiff", () => {
  it("returns an empty array for blank input", () => {
    expect(splitCombinedDiff("")).toEqual([]);
    expect(splitCombinedDiff("   \n  ")).toEqual([]);
  });

  it("splits a multi-file git diff into one FileDiff per file with correct counts", () => {
    const combined = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1111111..2222222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " unchanged",
      "-old a",
      "+new a",
      "diff --git a/src/b.ts b/src/b.ts",
      "index 3333333..4444444 100644",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,1 +1,2 @@",
      " unchanged b",
      "+new b line",
      "",
    ].join("\n");

    const files = splitCombinedDiff(combined);
    expect(files).toHaveLength(2);

    const a = files.find((f) => f.path === "src/a.ts");
    expect(a).toBeDefined();
    expect(a?.additions).toBe(1);
    expect(a?.deletions).toBe(1);
    expect(a?.patch).toContain("-old a");
    expect(a?.patch).toContain("+new a");

    const b = files.find((f) => f.path === "src/b.ts");
    expect(b).toBeDefined();
    expect(b?.additions).toBe(1);
    expect(b?.deletions).toBe(0);
    expect(b?.patch).toContain("+new b line");
  });

  it("strips the a/ b/ git path prefixes from the returned path", () => {
    const combined = [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");

    const files = splitCombinedDiff(combined);
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("README.md");
  });
});
