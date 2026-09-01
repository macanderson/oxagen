import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "./workspaces/memory";
import { buildWorkspaceTools } from "./tools";
import type { CodingEvent } from "./types";

async function run(tool: unknown, input: unknown): Promise<string> {
  // AI SDK tool().execute signature: (input, { toolCallId, messages }) => result
  return (
    tool as { execute: (i: unknown, o: unknown) => Promise<string> }
  ).execute(input, {});
}

describe("buildWorkspaceTools", () => {
  it("read_file returns line-numbered file content", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "hello\nworld" });
    const tools = buildWorkspaceTools(ws);
    expect(await run(tools.read_file, { path: "a.ts" })).toBe(
      "1\thello\n2\tworld",
    );
  });

  it("edit_file emits a file-edit event and mutates the workspace", async () => {
    const ws = new MemoryWorkspace({ "a.ts": "foo" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.edit_file, {
      path: "a.ts",
      old_string: "foo",
      new_string: "bar",
    });
    expect(await ws.readFile("a.ts")).toBe("bar");
    expect(
      events.some(
        (e) =>
          e.type === "file-edit" && e.path === "a.ts" && e.kind === "update",
      ),
    ).toBe(true);
  });

  it("write_file reports kind create for a new file and update for an existing one", async () => {
    const ws = new MemoryWorkspace({ "old.ts": "x" });
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    await run(tools.write_file, { path: "new.ts", content: "a" });
    await run(tools.write_file, { path: "old.ts", content: "b" });
    const edits = events.flatMap((e) =>
      e.type === "file-edit" ? [[e.path, e.kind]] : [],
    );
    expect(edits).toEqual([
      ["new.ts", "create"],
      ["old.ts", "update"],
    ]);
  });

  it("readOnly withholds mutating tools", () => {
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws, { readOnly: true });
    expect(tools.write_file).toBeUndefined();
    expect(tools.edit_file).toBeUndefined();
    expect(tools.bash).toBeUndefined();
    expect(tools.read_file).toBeDefined();
  });

  it("bash delegates to workspace.exec and emits a command event", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    }));
    const events: CodingEvent[] = [];
    const tools = buildWorkspaceTools(ws, { onEvent: (e) => events.push(e) });
    const out = await run(tools.bash, { command: "echo ok" });
    expect(out).toContain("ok");
    expect(events.some((e) => e.type === "command")).toBe(true);
  });
});
