/**
 * Additional coverage for MemoryWorkspace — gaps not covered by memory.test.ts:
 * default execHandler (lines 9-13), readFile with limit-only opts (line 29),
 * grep with path filter (line 67).
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./memory";

describe("MemoryWorkspace – exec default handler (lines 9-13)", () => {
  it("returns a zero-exit success result without calling onExec", async () => {
    const ws = new MemoryWorkspace({});
    // Do NOT call ws.onExec — exercises the default inline handler
    const result = await ws.exec("echo hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });
});

describe("MemoryWorkspace – readFile offset / limit combinations (line 29)", () => {
  it("returns all lines when no opts are given (early-return path)", async () => {
    const ws = new MemoryWorkspace({ "f.txt": "a\nb\nc" });
    expect(await ws.readFile("f.txt")).toBe("a\nb\nc");
  });

  it("returns a slice when both offset and limit are given", async () => {
    const ws = new MemoryWorkspace({ "f.txt": "L1\nL2\nL3\nL4" });
    expect(await ws.readFile("f.txt", { offset: 2, limit: 2 })).toBe("L2\nL3");
  });

  it("returns from start when only limit is given (offset defaults to 0)", async () => {
    const ws = new MemoryWorkspace({ "f.txt": "a\nb\nc\nd" });
    // offset is undefined → start = 0; limit = 2 → end = 2
    expect(await ws.readFile("f.txt", { limit: 2 })).toBe("a\nb");
  });

  it("reads from offset to end when only offset is given", async () => {
    const ws = new MemoryWorkspace({ "f.txt": "L1\nL2\nL3" });
    // offset = 2 → start = 1; limit undefined → end = lines.length
    expect(await ws.readFile("f.txt", { offset: 2 })).toBe("L2\nL3");
  });

  it("throws ENOENT when reading a missing file", async () => {
    const ws = new MemoryWorkspace({});
    await expect(ws.readFile("missing.txt")).rejects.toThrow("ENOENT");
  });
});

describe("MemoryWorkspace – grep with path and glob filters (line 67)", () => {
  it("restricts results to files under a given path prefix", async () => {
    const ws = new MemoryWorkspace({
      "src/a.ts": "const x = 1",
      "lib/b.ts": "const x = 2",
    });
    const hits = await ws.grep("const x", { path: "src" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("src/a.ts");
  });

  it("returns no hits when path prefix matches no files", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "hello" });
    const hits = await ws.grep("hello", { path: "lib" });
    expect(hits).toHaveLength(0);
  });

  it("restricts results by glob pattern (without path)", async () => {
    const ws = new MemoryWorkspace({
      "src/a.ts": "export const a = 1",
      "src/b.js": "export const a = 2",
    });
    const hits = await ws.grep("export", { glob: "*.ts" });
    expect(hits.every((h) => h.startsWith("src/a.ts"))).toBe(true);
  });

  it("combines path and glob filters", async () => {
    const ws = new MemoryWorkspace({
      "src/x.ts": "foo",
      "src/x.js": "foo",
      "lib/x.ts": "foo",
    });
    const hits = await ws.grep("foo", { path: "src", glob: "*.ts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("src/x.ts");
  });
});

describe("MemoryWorkspace – diff for added files", () => {
  it("includes newly written files in the diff output", async () => {
    const ws = new MemoryWorkspace({});
    await ws.writeFile("new.ts", "export {}");
    const d = await ws.diff();
    expect(d).toContain("new.ts");
  });
});

describe("MemoryWorkspace – list with dot directory", () => {
  it("returns top-level entries when listing root (.)", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "", "b.ts": "", "sub/c.ts": "" });
    const entries = await ws.list(".");
    expect(entries).toContain("a.ts");
    expect(entries).toContain("b.ts");
    expect(entries).toContain("sub");
  });
});
