/**
 * Additional coverage for buildWorkspaceTools — tools not exercised by tools.test.ts:
 * write_file, list_dir, glob, grep, code_graph execute, bash error/timeout paths.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
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
