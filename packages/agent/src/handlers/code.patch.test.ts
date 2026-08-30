import { describe, expect, it } from "vitest";
import { codePatchHandler } from "./code.patch";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const MODIFY_DIFF = `--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-hello\n+world\n`;
const ADD_DIFF = `--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2\n`;
const DELETE_DIFF = `--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line1\n-line2\n`;

describe("code.patch handler", () => {
  it("applies a modify hunk and returns the changed file", async () => {
    const r = await codePatchHandler(
      { files: { "x.txt": "hello\n" }, diff: MODIFY_DIFF },
      CTX,
    );
    expect(r.applied).toBe(true);
    expect(r.changedCount).toBe(1);
    expect(r.files[0]).toEqual({
      path: "x.txt",
      status: "modified",
      content: "world\n",
    });
  });

  it("applies an add hunk against an empty workspace", async () => {
    const r = await codePatchHandler({ files: {}, diff: ADD_DIFF }, CTX);
    expect(r.files[0]!.status).toBe("added");
    expect(r.files[0]!.path).toBe("new.txt");
    expect(r.files[0]!.content).toBe("line1\nline2\n");
  });

  it("applies a delete hunk and reports the file as deleted", async () => {
    const r = await codePatchHandler(
      { files: { "old.txt": "line1\nline2\n" }, diff: DELETE_DIFF },
      CTX,
    );
    expect(r.files[0]!.status).toBe("deleted");
    expect(r.files[0]!.path).toBe("old.txt");
    expect(r.files[0]!.content).toBe("");
  });

  it("applies a multi-file diff and returns every changed file", async () => {
    const multi = MODIFY_DIFF + ADD_DIFF;
    const r = await codePatchHandler(
      { files: { "x.txt": "hello\n" }, diff: multi },
      CTX,
    );
    expect(r.changedCount).toBe(2);
    expect(r.files.map((f) => f.path).sort()).toEqual(["new.txt", "x.txt"]);
  });

  it("rejects a diff whose target escapes the workspace (path traversal)", async () => {
    const evil = `--- a/x.txt\n+++ b/../escape.txt\n@@ -1 +1 @@\n-a\n+b\n`;
    await expect(
      codePatchHandler({ files: { "x.txt": "a\n" }, diff: evil }, CTX),
    ).rejects.toThrow(/unsafe workspace path/);
  });

  it("rejects a diff whose target is an absolute path", async () => {
    const evil = `--- a/x.txt\n+++ /etc/passwd\n@@ -1 +1 @@\n-a\n+b\n`;
    await expect(
      codePatchHandler({ files: { "x.txt": "a\n" }, diff: evil }, CTX),
    ).rejects.toThrow(/unsafe workspace path/);
  });

  it("rejects a hunk that does not apply cleanly", async () => {
    const bad = `--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-NOTPRESENT\n+world\n`;
    await expect(
      codePatchHandler({ files: { "x.txt": "hello\n" }, diff: bad }, CTX),
    ).rejects.toThrow(/failed to apply cleanly/);
  });

  it("rejects a malformed diff with no hunks", async () => {
    await expect(
      codePatchHandler({ files: {}, diff: "this is not a diff" }, CTX),
    ).rejects.toThrow(/code\.patch/);
  });
});
