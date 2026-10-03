// Splitting a stored unified diff into files (ADR-292): headers, renames,
// deletions, binary files, quoted paths, and the per-file cap.
import { describe, expect, it } from "vitest";
import { capHunks, splitUnifiedDiff } from "./diff-split";

describe("splitUnifiedDiff", () => {
  it("splits files at each header and keeps each one's hunks from its first @@ line", () => {
    const text = [
      "diff --git a/a.ts b/a.ts",
      "index 1..2 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    expect(splitUnifiedDiff(text)).toEqual([
      { path: "a.ts", hunks: "@@ -1 +1 @@\n-x\n+y", binary: false },
      { path: "gone.ts", hunks: "@@ -1 +0,0 @@\n-bye", binary: false },
    ]);
  });

  it("names a rename's old path and marks a binary file with no hunks", () => {
    const text = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "diff --git a/logo.png b/logo.png",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(splitUnifiedDiff(text)).toEqual([
      { path: "new.ts", previousPath: "old.ts", hunks: "", binary: false },
      { path: "logo.png", hunks: "", binary: true },
    ]);
  });

  it("unquotes a path git wrote in quotes", () => {
    const text = 'diff --git "a/sp ace.ts" "b/sp ace.ts"\n--- "a/sp ace.ts"\n+++ b/sp ace.ts\n@@ -1 +1 @@\n-a\n+b';
    expect(splitUnifiedDiff(text)[0]?.path).toBe("sp ace.ts");
  });

  it("answers nothing for text with no header (negative)", () => {
    expect(splitUnifiedDiff("not a diff\n")).toEqual([]);
  });
});

describe("capHunks", () => {
  it("cuts at a line end and says so", () => {
    expect(capHunks("@@ a\n+1\n+2\n", 8)).toEqual({ text: "@@ a\n+1", truncated: true });
    expect(capHunks("@@ a\n+1", 100)).toEqual({ text: "@@ a\n+1", truncated: false });
  });
});
