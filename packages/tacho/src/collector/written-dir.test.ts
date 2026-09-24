/**
 * Where the agent writes decides which checkout the daemon reads git from.
 */
import { describe, expect, it } from "vitest";
import { writtenDir } from "./hook-handler";

describe("writtenDir", () => {
  it("names the directory of a file a write tool names by absolute path", () => {
    for (const tool_name of ["Edit", "Write", "MultiEdit"])
      expect(
        writtenDir({
          hook_event_name: "PreToolUse",
          tool_name,
          tool_input: { file_path: "/worktrees/repo/fix/src/a.ts" },
        }),
      ).toBe("/worktrees/repo/fix/src");
    expect(
      writtenDir({
        hook_event_name: "PostToolUse",
        tool_name: "NotebookEdit",
        tool_input: { notebook_path: "/repo/n.ipynb" },
      }),
    ).toBe("/repo");
  });

  it("ignores reads, relative paths, and hooks that are not tool calls", () => {
    expect(
      writtenDir({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/other/repo/a.ts" },
      }),
    ).toBeUndefined();
    expect(
      writtenDir({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "src/a.ts" },
      }),
    ).toBeUndefined();
    expect(
      writtenDir({ hook_event_name: "Stop", tool_name: "Write" }),
    ).toBeUndefined();
  });
});
