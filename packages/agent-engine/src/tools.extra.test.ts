/**
 * Additional coverage for buildWorkspaceTools — tools not exercised by tools.test.ts:
 * write_file, list_dir, glob, grep, code_graph execute, bash error/timeout paths.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools, formatWithLineNumbers, describeEditFailure, clip } from "./tools";
import type { CodingEvent } from "./types";

async function run(tool: unknown, input: unknown): Promise<string> {
  return (tool as { execute: (i: unknown, o: unknown) => Promise<string> }).execute(input, {});
}

describe("buildWorkspaceTools – write_file", () => {
  it("creates a new file and returns a byte-count confirmation", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, { path: "new.ts", content: "hello" });
    expect(result).toContain("5");
    expect(result).toContain("new.ts");
    expect(await ws.readFile("new.ts")).toBe("hello");
  });

  it("emits a file-edit event on write", async () => {
    const ws = new MemoryWorkspace({});
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.write_file, { path: "x.ts", content: "abc" });
    expect(events.some((e) => e.type === "file-edit" && e.path === "x.ts")).toBe(true);
  });

  it("returns an error string when write fails", async () => {
    const ws = new MemoryWorkspace({});
    // Simulate writeFile throwing
    ws.writeFile = async () => { throw new Error("disk full"); };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.write_file, { path: "fail.ts", content: "x" });
    expect(result).toContain("Error writing");
    expect(result).toContain("disk full");
  });
});

describe("buildWorkspaceTools – list_dir", () => {
  it("returns entries of a directory", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "", "src/b.ts": "", "src/sub/c.ts": "" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "src" });
    expect(result).toContain("a.ts");
    expect(result).toContain("b.ts");
    expect(result).toContain("sub");
  });

  it("returns (empty) for an empty directory", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "." });
    expect(result).toBe("(empty)");
  });

  it("returns an error string when list fails", async () => {
    const ws = new MemoryWorkspace({});
    ws.list = async () => { throw new Error("permission denied"); };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.list_dir, { path: "restricted" });
    expect(result).toContain("Error listing");
    expect(result).toContain("permission denied");
  });
});

describe("buildWorkspaceTools – glob", () => {
  it("returns sorted matches for a glob pattern", async () => {
    const ws = new MemoryWorkspace({ "src/a.ts": "", "src/b.ts": "", "lib/c.js": "" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.glob, { pattern: "src/*.ts" });
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).not.toContain("lib/c.js");
  });

  it("returns (no matches) for a pattern with no results", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.glob, { pattern: "**/*.py" });
    expect(result).toBe("(no matches)");
  });

  it("returns an error string when glob fails", async () => {
    const ws = new MemoryWorkspace({});
    ws.glob = async () => { throw new Error("invalid pattern"); };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.glob, { pattern: "[bad" });
    expect(result).toContain("Error globbing");
    expect(result).toContain("invalid pattern");
  });
});

describe("buildWorkspaceTools – grep", () => {
  it("returns file:line:text hits", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const x = 1\nconst y = 2" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.grep, { pattern: "const y" });
    expect(result).toContain("a.ts:2:const y = 2");
  });

  it("returns (no matches) when pattern is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.grep, { pattern: "zzz" });
    expect(result).toBe("(no matches)");
  });

  it("returns an error string when grep fails", async () => {
    const ws = new MemoryWorkspace({});
    ws.grep = async () => { throw new Error("regex error"); };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.grep, { pattern: "(?bad" });
    expect(result).toContain("Error grepping");
    expect(result).toContain("regex error");
  });
});

describe("buildWorkspaceTools – read_file error path", () => {
  it("returns an error string when file does not exist", async () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.read_file, { path: "missing.ts" });
    expect(result).toContain("Error reading missing.ts");
    expect(result).toContain("ENOENT");
  });
});

describe("buildWorkspaceTools – edit_file error path", () => {
  it("returns an error string when old_string is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello" });
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.edit_file, { path: "a.ts", old_string: "zzz", new_string: "x" });
    expect(result).toContain("Error editing a.ts");
    expect(result).toContain("not found");
  });
});

describe("buildWorkspaceTools – code_graph execute", () => {
  it("delegates to the provider and returns clipped output", async () => {
    const ws = new MemoryWorkspace({});
    const codeGraph = { query: async () => "symbol found at src/x.ts:10" };
    const tools = buildWorkspaceTools(ws, { codeGraph });
    const result = await run(tools.code_graph, { operation: "search", query: "myFn" });
    expect(result).toBe("symbol found at src/x.ts:10");
  });

  it("returns a code_graph error string when provider throws", async () => {
    const ws = new MemoryWorkspace({});
    const codeGraph = { query: async (): Promise<string> => { throw new Error("index not ready"); } };
    const tools = buildWorkspaceTools(ws, { codeGraph });
    const result = await run(tools.code_graph, { operation: "file_symbols", query: "src/x.ts" });
    expect(result).toContain("code_graph error");
    expect(result).toContain("index not ready");
  });
});

describe("buildWorkspaceTools – bash error paths", () => {
  it("returns a timed-out message when exec timedOut is true", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({ exitCode: 124, stdout: "", stderr: "", timedOut: true }));
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    const result = await run(tools.bash, { command: "sleep 9999", timeout_ms: 100 });
    expect(result).toContain("timed out");
    // event is still emitted before the timedOut check
    expect(events.some((e) => e.type === "command")).toBe(true);
  });

  it("returns a failure message when exit code is non-zero", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({ exitCode: 1, stdout: "", stderr: "build failed", timedOut: false }));
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.bash, { command: "pnpm build" });
    expect(result).toContain("Command failed");
    expect(result).toContain("build failed");
  });

  it("returns an error string when exec throws", async () => {
    const ws = new MemoryWorkspace({});
    ws.exec = async () => { throw new Error("spawn failed"); };
    const tools = buildWorkspaceTools(ws);
    const result = await run(tools.bash, { command: "bad-cmd" });
    expect(result).toContain("Error running command");
    expect(result).toContain("spawn failed");
  });

  it("caps timeout_ms at 600000", async () => {
    const ws = new MemoryWorkspace({});
    const observed: number[] = [];
    ws.exec = async (_cmd, opts) => {
      observed.push(opts?.timeoutMs ?? -1);
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };
    const tools = buildWorkspaceTools(ws);
    await run(tools.bash, { command: "echo", timeout_ms: 9_999_999 });
    expect(observed[0]).toBe(600_000);
  });
});

describe("per-tool timeout backstop", () => {
  it("toolBackstopMs honors bash's declared timeout_ms plus grace, capped at max", async () => {
    const { toolBackstopMs } = await import("./tools");
    expect(toolBackstopMs("bash", { timeout_ms: 500_000 })).toBe(530_000);
    expect(toolBackstopMs("bash", {})).toBe(150_000); // default 120s + 30s grace
    expect(toolBackstopMs("bash", { timeout_ms: 9_999_999 })).toBe(630_000); // capped at 600s
    expect(toolBackstopMs("read_file", {})).toBe(60_000);
    expect(toolBackstopMs("grep", null)).toBe(60_000);
  });

  it("a wedged tool resolves to a backstop timeout string instead of hanging", async () => {
    const { vi } = await import("vitest");
    vi.useFakeTimers();
    try {
      const ws = new MemoryWorkspace({});
      // Wedge grep: never resolves — the backstop must fire at 60s.
      ws.grep = () => new Promise(() => {});
      const tools = buildWorkspaceTools(ws);
      const pending = run(tools.grep, { pattern: "x" });
      await vi.advanceTimersByTimeAsync(60_001);
      const out = await pending;
      expect(out).toContain("timed out after 60s (backstop)");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatWithLineNumbers", () => {
  it("prefixes each line with a right-aligned number and a tab", () => {
    expect(formatWithLineNumbers("a\nb\nc")).toBe("1\ta\n2\tb\n3\tc");
  });

  it("reflects the true starting line number (offset-based) and right-aligns", () => {
    // 10 lines starting at line 2 pushes the max number to 11 → width 2, so the
    // single-digit numbers are space-padded.
    const text = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
    const out = formatWithLineNumbers(text, 2);
    expect(out.startsWith(" 2\tL0\n")).toBe(true);
    expect(out).toContain("11\tL9");
  });

  it("does not number the empty tail after a trailing newline", () => {
    expect(formatWithLineNumbers("a\nb\n")).toBe("1\ta\n2\tb");
  });

  it("returns an empty string for empty input", () => {
    expect(formatWithLineNumbers("")).toBe("");
  });
});

describe("buildWorkspaceTools – read_file line numbers", () => {
  it("numbers lines with their true file line number when offset is given", async () => {
    const ws = new MemoryWorkspace({ "n.txt": "l1\nl2\nl3\nl4\nl5" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.read_file, { path: "n.txt", offset: 2, limit: 2 });
    expect(out).toBe("2\tl2\n3\tl3");
  });

  it("still clips output over the 30k cap (middle-out)", async () => {
    const ws = new MemoryWorkspace({ "big.txt": "x".repeat(40_000) });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.read_file, { path: "big.txt" });
    expect(out).toContain("truncated from the middle");
    expect(out.length).toBeLessThan(31_000);
  });
});

describe("clip (middle-out truncation)", () => {
  it("returns short text unchanged", () => {
    expect(clip("hello")).toBe("hello");
  });

  it("keeps BOTH the head and the tail, dropping the middle", () => {
    // HEAD marker at the very start, TAIL marker at the very end — the tail is
    // where a failing test/build puts its verdict, which head-only truncation lost.
    const text = "HEAD_START" + "m".repeat(40_000) + "TAIL_END";
    const out = clip(text);
    expect(out.startsWith("HEAD_START")).toBe(true);
    expect(out.endsWith("TAIL_END")).toBe(true);
    expect(out).toContain("truncated from the middle");
    expect(out.length).toBeLessThan(31_000);
  });
});

describe("describeEditFailure", () => {
  it("returns null when old_string appears exactly once", () => {
    expect(describeEditFailure("a\nunique\nb", "unique")).toBeNull();
  });

  it("names the closest line and hints at whitespace when not found", () => {
    const msg = describeEditFailure("const foo = 1;\nconst bar = 2;", "const fooo = 1;");
    expect(msg).toContain("not found");
    expect(msg).toContain("Closest match at line 1");
    expect(msg).toContain("const foo = 1;");
    expect(msg).toContain("Check exact whitespace");
  });

  it("lists occurrence line numbers and suggests replace_all when ambiguous", () => {
    const msg = describeEditFailure("x\ny\nx\nz\nx", "x");
    expect(msg).toContain("appears 3 times");
    expect(msg).toContain("lines 1, 3, 5");
    expect(msg).toContain("replace_all");
  });
});

describe("buildWorkspaceTools – edit_file replace_all + structured feedback", () => {
  it("replace_all replaces every occurrence and reports the count", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "a\na\na" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    expect(out).toContain("3 replacements");
    expect(await ws.readFile("a.ts")).toBe("b\nb\nb");
  });

  it("leaves the single-match success message unchanged", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo bar" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, { path: "a.ts", old_string: "bar", new_string: "baz" });
    expect(out).toBe("Edited a.ts");
  });

  it("names the closest line when old_string is not found", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "const foo = 1;" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, {
      path: "a.ts",
      old_string: "const fooo = 1;",
      new_string: "x",
    });
    expect(out).toContain("Error editing a.ts");
    expect(out).toContain("Closest match at line 1");
  });

  it("lists lines and suggests replace_all on an ambiguous match, without mutating", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "x\nx\nx" });
    const tools = buildWorkspaceTools(ws);
    const out = await run(tools.edit_file, { path: "a.ts", old_string: "x", new_string: "y" });
    expect(out).toContain("appears 3 times");
    expect(out).toContain("replace_all");
    expect(await ws.readFile("a.ts")).toBe("x\nx\nx");
  });
});
