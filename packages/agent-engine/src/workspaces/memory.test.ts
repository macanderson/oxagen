import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./memory";

describe("MemoryWorkspace", () => {
  it("reads and writes files", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "hello" });
    expect(await ws.readFile("a.txt")).toBe("hello");
    await ws.writeFile("b.txt", "world");
    expect(await ws.readFile("b.txt")).toBe("world");
  });

  it("editFile replaces a unique substring and rejects non-unique", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "foo bar foo" });
    await expect(ws.editFile("a.txt", "foo", "x")).rejects.toThrow(
      /unique|appears/i,
    );
    await ws.editFile("a.txt", "bar", "baz");
    expect(await ws.readFile("a.txt")).toBe("foo baz foo");
  });

  it("glob matches ** and * patterns", async () => {
    const ws = new MemoryWorkspace({
      "src/x.ts": "",
      "src/deep/y.ts": "",
      "z.js": "",
    });
    expect((await ws.glob("src/**/*.ts")).sort()).toEqual([
      "src/deep/y.ts",
      "src/x.ts",
    ]);
  });

  it("grep returns file:line:text hits", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const a = 1\nconst b = 2" });
    expect(await ws.grep("const b")).toEqual(["a.ts:2:const b = 2"]);
  });

  it("diff reports changed files", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "1" });
    await ws.writeFile("a.txt", "2");
    const d = await ws.diff();
    expect(d).toContain("a.txt");
  });

  it("editFile rejects when old_string is absent", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "hello" });
    await expect(ws.editFile("a.txt", "zzz", "x")).rejects.toThrow(
      /not found/i,
    );
  });

  it("editFile replaceAll replaces every occurrence and returns the count", async () => {
    const ws = new MemoryWorkspace({ "a.txt": "foo bar foo" });
    const n = await ws.editFile("a.txt", "foo", "X", { replaceAll: true });
    expect(n).toBe(2);
    expect(await ws.readFile("a.txt")).toBe("X bar X");
  });

  it("list returns immediate children only (non-recursive)", async () => {
    const ws = new MemoryWorkspace({ "src/x.ts": "", "src/deep/y.ts": "" });
    expect((await ws.list("src")).sort()).toEqual(["deep", "x.ts"]);
  });
});
