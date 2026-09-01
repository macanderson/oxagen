/**
 * Smoke-test that the barrel index re-exports all public symbols.
 * Importing from ./index executes the re-export module and gives it v8 coverage.
 */
import { describe, it, expect } from "vitest";
import {
  MemoryWorkspace,
  buildWorkspaceTools,
  runCodingAgent,
  changedFilesFromDiff,
} from "./index";

describe("index barrel exports", () => {
  it("exports MemoryWorkspace and it can be instantiated", () => {
    expect(MemoryWorkspace).toBeDefined();
    const ws = new MemoryWorkspace({ "a.ts": "hello" }, "/workspace");
    expect(ws.root).toBe("/workspace");
  });

  it("exports buildWorkspaceTools as a function", () => {
    expect(typeof buildWorkspaceTools).toBe("function");
    const ws = new MemoryWorkspace({});
    const tools = buildWorkspaceTools(ws);
    expect(tools.read_file).toBeDefined();
    expect(tools.search).toBeDefined();
  });

  it("exports runCodingAgent as a function", () => {
    expect(typeof runCodingAgent).toBe("function");
  });

  it("exports changedFilesFromDiff and it works correctly", () => {
    expect(typeof changedFilesFromDiff).toBe("function");
    expect(changedFilesFromDiff("--- a/x.ts\n+++ b/x.ts")).toEqual(["x.ts"]);
    expect(changedFilesFromDiff("")).toEqual([]);
  });
});
