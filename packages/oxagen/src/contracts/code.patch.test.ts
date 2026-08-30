import { describe, expect, it } from "vitest";
import { codePatch } from "./code.patch";
import { getCapability } from "../registry";

const SAMPLE_DIFF = `--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-hello\n+world\n`;

describe("code.patch capability", () => {
  it("accepts a valid input", () => {
    const parsed = codePatch.input.parse({
      files: { "x.txt": "hello\n" },
      diff: SAMPLE_DIFF,
    });
    expect(parsed.files).toEqual({ "x.txt": "hello\n" });
    expect(parsed.diff).toBe(SAMPLE_DIFF);
  });

  it("accepts an empty workspace (add-only patch)", () => {
    const parsed = codePatch.input.parse({ files: {}, diff: SAMPLE_DIFF });
    expect(parsed.files).toEqual({});
  });

  it("rejects a files map with a path-traversal key", () => {
    expect(() =>
      codePatch.input.parse({ files: { "../escape": "x" }, diff: SAMPLE_DIFF }),
    ).toThrow();
  });

  it("rejects a files map with an absolute path key", () => {
    expect(() =>
      codePatch.input.parse({
        files: { "/etc/passwd": "x" },
        diff: SAMPLE_DIFF,
      }),
    ).toThrow();
  });

  it("rejects an empty diff", () => {
    expect(() =>
      codePatch.input.parse({ files: { "x.txt": "hello\n" }, diff: "" }),
    ).toThrow();
  });

  it("rejects an over-large diff", () => {
    const huge = "x".repeat(2 * 1024 * 1024 + 1);
    expect(() =>
      codePatch.input.parse({ files: { "x.txt": "" }, diff: huge }),
    ).toThrow();
  });

  it("parses a valid output with a changed-file list", () => {
    const parsed = codePatch.output.parse({
      applied: true,
      files: [{ path: "x.txt", status: "modified", content: "world\n" }],
      changedCount: 1,
    });
    expect(parsed.applied).toBe(true);
    expect(parsed.files[0]!.status).toBe("modified");
  });

  it("rejects an output file with an unknown status", () => {
    expect(() =>
      codePatch.output.parse({
        applied: true,
        files: [{ path: "x", status: "renamed", content: "" }],
        changedCount: 1,
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("patch_code")).toBe(codePatch);
  });

  it("declares the api, mcp, and agent surfaces", () => {
    expect(codePatch.surfaces).toEqual(["api", "mcp", "agent"]);
  });
});
