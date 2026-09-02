import { describe, expect, it } from "vitest";
import { codeDiffHandler } from "./code.diff";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

describe("code.diff handler", () => {
  it("returns an empty diff and changed=false for identical blobs", async () => {
    const r = await codeDiffHandler(
      { before: "a\n", after: "a\n", path: "file", contextLines: 3 },
      CTX,
    );
    expect(r.changed).toBe(false);
    expect(r.diff).toBe("");
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(0);
  });

  it("produces a unified diff with a/ b/ headers and counts a substitution", async () => {
    const r = await codeDiffHandler(
      { before: "hello\n", after: "world\n", path: "x.txt", contextLines: 3 },
      CTX,
    );
    expect(r.changed).toBe(true);
    expect(r.diff).toContain("--- a/x.txt");
    expect(r.diff).toContain("+++ b/x.txt");
    expect(r.diff).toContain("-hello");
    expect(r.diff).toContain("+world");
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(1);
  });

  it("counts multiple added lines and zero deletions", async () => {
    const r = await codeDiffHandler(
      { before: "a\n", after: "a\nb\nc\n", path: "f", contextLines: 3 },
      CTX,
    );
    expect(r.additions).toBe(2);
    expect(r.deletions).toBe(0);
    expect(r.changed).toBe(true);
  });

  it("honours contextLines=0 (tighter hunks)", async () => {
    const before =
      Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n") + "\n";
    const after = before.replace("l5", "L5");
    const r = await codeDiffHandler(
      { before, after, path: "f", contextLines: 0 },
      CTX,
    );
    expect(r.diff).toContain("-l5");
    expect(r.diff).toContain("+L5");
    // With zero context, the unchanged neighbours must not appear in the hunk.
    expect(r.diff).not.toContain(" l4");
  });
});
