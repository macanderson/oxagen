// tools-structured/index.ts
//
// Deterministic structured tools (ADR-021 §3) — contract-shaped diagnostic tools
// with typed, bounded output that replace the model parsing raw `bash` output for
// its most common mechanical duties (running tests, typechecking, reading a diff,
// checking repo state). Every tool here executes through the injected Workspace
// port only (workspace.exec/grep/list) so the engine stays dependency-light — no
// direct child_process, no platform imports — and contains ZERO model calls
// (ADR-021 §1: these duties sit on the pure-function / index rungs of the
// determinism ladder, never the model rung).
//
// buildWorkspaceTools (../tools.ts) merges these alongside read_file/bash/
// code_graph so every surface (CLI, app, API, MCP sandbox) advertises them
// identically.

import type { ToolSet } from "ai";
import type { Workspace, CodingEvent } from "../types";
import { buildTestRunUnitTool } from "./test-run-unit";
import { buildBuildExecuteTool } from "./build-execute";
import { buildGitDiffSummarizeTool } from "./git-diff-summarize";
import { buildWorkspaceHealthCheckTool } from "./workspace-health-check";

export interface StructuredToolOptions {
  /** Turn abort signal, forwarded to workspace.exec so an aborted turn kills the child. */
  signal?: AbortSignal;
  /** Lifecycle sink — emits a `command` CodingEvent per shell-out, like bash. */
  onEvent?: (e: CodingEvent) => void;
}

/**
 * Build the deterministic structured tools bound to `workspace`. All four are
 * read-oriented diagnostics (they run tests/typecheck/diff/status but never
 * mutate files), so they are advertised in both read-write and read-only modes.
 */
export function buildStructuredTools(
  workspace: Workspace,
  opts: StructuredToolOptions = {},
): ToolSet {
  const deps = { signal: opts.signal, onEvent: opts.onEvent };
  return {
    test_run_unit: buildTestRunUnitTool(workspace, deps),
    build_execute: buildBuildExecuteTool(workspace, deps),
    git_diff_summarize: buildGitDiffSummarizeTool(workspace, deps),
    workspace_health_check: buildWorkspaceHealthCheckTool(workspace, deps),
  };
}

// Re-export the pure parsers/selectors so the unit tests exercise them directly.
export * from "./parse";
export { selectTestsForChanges, buildVitestCommand } from "./test-run-unit";
export { buildCompileCommand } from "./build-execute";
export { buildDiffCommands } from "./git-diff-summarize";
export { parseEslintJson } from "./workspace-health-check";
