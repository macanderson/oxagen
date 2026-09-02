/**
 * Coverage for test_trace_run (Phase 2 "debugger in the loop" v1): the traced
 * vitest command shape, the remote summarizer command, the summary parser, and
 * the tool's execute flow — happy path, degraded trace, timeout, and the
 * always-cleanup guarantee. House style: DI via MemoryWorkspace.onExec, no
 * vi.mock.
 */
import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import {
  buildTraceCommand,
  buildTraceSummarizeCommand,
  parseTraceSummary,
  buildTestTraceRunTool,
  TRACE_FILE_CAPS,
} from "./test-trace-run";
import type { CommandResult } from "../types";

const VITEST_FAIL_JSON = JSON.stringify({
  numPassedTests: 2,
  numFailedTests: 1,
  numPendingTests: 0,
  testResults: [
    {
      name: "src/foo.test.ts",
      startTime: 1000,
      endTime: 1500,
      assertionResults: [
        { status: "passed", title: "a" },
        { status: "passed", title: "b" },
        {
          status: "failed",
          title: "c",
          fullName: "foo > c",
          failureMessages: ["AssertionError: expected 1 to be 2"],
        },
      ],
    },
  ],
});

const SUMMARY_JSON = JSON.stringify({
  files: [
    { p: "src/foo.ts", n: 7, t: ["frobnicate", "helper"] },
    { p: "src/bar.ts", n: 2, t: [] },
  ],
  scanned: 3,
});

type ExecuteFn = (input: unknown, options: unknown) => Promise<unknown>;

function makeTraceTool(handler: (cmd: string) => CommandResult): {
  execute: ExecuteFn;
  commands: string[];
} {
  const ws = new MemoryWorkspace({}, "/repo");
  const commands: string[] = [];
  ws.onExec((cmd) => {
    commands.push(cmd);
    return handler(cmd);
  });
  const tool = buildTestTraceRunTool(ws, {}) as unknown as {
    execute: ExecuteFn;
  };
  return { execute: (i, o) => tool.execute(i, o), commands };
}

const ok = (stdout: string): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

describe("buildTraceCommand", () => {
  it("enables source-mapped V8 coverage, quotes the file, and zeroes thresholds", () => {
    const cmd = buildTraceCommand({
      file: "src/a b.test.ts",
      coverageDir: ".oxagen-trace-x",
      testName: "does it's thing",
    });
    expect(cmd).toContain("pnpm exec vitest run 'src/a b.test.ts'");
    expect(cmd).toContain("-t 'does it'\\''s thing'");
    expect(cmd).toContain("--reporter=json");
    expect(cmd).toContain("--coverage.enabled");
    expect(cmd).toContain("--coverage.provider=v8");
    expect(cmd).toContain("--coverage.reportsDirectory='.oxagen-trace-x'");
    // A one-file trace must never trip the package's coverage ratchet.
    expect(cmd).toContain("--coverage.thresholds.lines=0");
    expect(cmd).toContain("--coverage.thresholds.functions=0");
    expect(cmd).toContain("--coverage.thresholds.branches=0");
    expect(cmd).toContain("--coverage.thresholds.statements=0");
  });

  it("omits -t when no test name is given", () => {
    expect(
      buildTraceCommand({ file: "a.test.ts", coverageDir: "d" }),
    ).not.toContain(" -t ");
  });
});

describe("buildTraceSummarizeCommand / parseTraceSummary", () => {
  it("builds a node one-liner carrying dir, root, and cap", () => {
    const cmd = buildTraceSummarizeCommand({
      coverageDir: ".oxagen-trace-x",
      root: "/repo",
      maxFiles: 20,
    });
    expect(cmd.startsWith("node -e ")).toBe(true);
    expect(cmd).toContain("'.oxagen-trace-x'");
    expect(cmd).toContain("'/repo'");
    expect(cmd.endsWith(" 20")).toBe(true);
  });

  it("the embedded script is executable and summarizes a real istanbul report", async () => {
    // Run the ACTUAL command against a real temp dir with a realistic
    // coverage-final.json (istanbul format, as @vitest/coverage-v8 writes it).
    const { execSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "oxtrace-"));
    const root = "/repo";
    writeFileSync(
      join(dir, "coverage-final.json"),
      JSON.stringify({
        "/repo/src/foo.ts": {
          fnMap: {
            "0": { name: "ran" },
            "1": { name: "cold" },
            "2": { name: "(anonymous_2)" },
          },
          f: { "0": 3, "1": 0, "2": 5 },
        },
        "/repo/src/never-loaded.ts": {
          fnMap: { "0": { name: "(empty-report)" } },
          f: { "0": 1 },
        },
        "/repo/node_modules/x/index.js": {
          fnMap: { "0": { name: "dep" } },
          f: { "0": 9 },
        },
        "/elsewhere/out.ts": {
          fnMap: { "0": { name: "away" } },
          f: { "0": 1 },
        },
      }),
    );
    try {
      const cmd = buildTraceSummarizeCommand({
        coverageDir: dir,
        root,
        maxFiles: 10,
      });
      const stdout = execSync(cmd, { encoding: "utf8" });
      const summary = parseTraceSummary(stdout);
      // foo.ts: "ran" + one anonymous executed (anonymous excluded from names);
      // the (empty-report) placeholder, node_modules, and out-of-root are skipped.
      expect(summary).toEqual({
        files: [
          { path: "src/foo.ts", executedFunctions: 2, topFunctions: ["ran"] },
        ],
        scanned: 4,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a summary with leading noise and filters malformed entries", () => {
    const noisy = `some warning\n${JSON.stringify({
      files: [
        { p: "a.ts", n: 3, t: ["f", 42] },
        { p: 7, n: 1 },
      ],
      scanned: 2,
    })}`;
    expect(parseTraceSummary(noisy)).toEqual({
      files: [{ path: "a.ts", executedFunctions: 3, topFunctions: ["f"] }],
      scanned: 2,
    });
  });

  it("returns null for garbage", () => {
    expect(parseTraceSummary("vitest exploded")).toBeNull();
    expect(parseTraceSummary('{"files": not json')).toBeNull();
  });
});

describe("test_trace_run — execute flow", () => {
  it("returns pass/fail plus the ranked executed path, then cleans up", async () => {
    const { execute, commands } = makeTraceTool((cmd) => {
      if (cmd.includes("vitest run")) return ok(VITEST_FAIL_JSON);
      if (cmd.startsWith("node -e")) return ok(SUMMARY_JSON);
      return ok(""); // rm -rf
    });
    const result = (await execute(
      { test_file: "src/foo.test.ts", test_name: "c" },
      {},
    )) as Record<string, unknown>;

    expect(result["passed"]).toBe(2);
    expect(result["failed"]).toBe(1);
    expect(result["executedPath"]).toEqual({
      files: [
        {
          path: "src/foo.ts",
          executedFunctions: 7,
          topFunctions: ["frobnicate", "helper"],
        },
        { path: "src/bar.ts", executedFunctions: 2, topFunctions: [] },
      ],
      scanned: 3,
    });
    expect(String(result["hint"])).toContain("executedPath");
    // Traced run → summarizer → cleanup, in order.
    expect(commands[0]).toContain("--coverage.enabled");
    expect(commands[1]).toMatch(/^node -e /);
    expect(commands[2]).toMatch(/^rm -rf '\.oxagen-trace-/);
  });

  it("degrades to pass/fail alone when the summarizer output is unparseable", async () => {
    const { execute } = makeTraceTool((cmd) => {
      if (cmd.includes("vitest run")) return ok(VITEST_FAIL_JSON);
      if (cmd.startsWith("node -e")) return ok("boom not json");
      return ok("");
    });
    const result = (await execute({ test_file: "t.test.ts" }, {})) as Record<
      string,
      unknown
    >;
    expect(result["failed"]).toBe(1);
    expect(result["executedPath"]).toBeUndefined();
    expect(result["traceDegraded"]).toBe(true);
  });

  it("reports a timeout and still removes the coverage dir", async () => {
    const { execute, commands } = makeTraceTool((cmd) => {
      if (cmd.includes("vitest run"))
        return { exitCode: 1, stdout: "", stderr: "", timedOut: true };
      return ok("");
    });
    const result = (await execute({ test_file: "t.test.ts" }, {})) as Record<
      string,
      unknown
    >;
    expect(result["timedOut"]).toBe(true);
    expect(commands.some((c) => c.startsWith("rm -rf"))).toBe(true);
  });

  it("falls back to exit code + stderr tail when the reporter JSON is unparseable", async () => {
    const { execute } = makeTraceTool((cmd) => {
      if (cmd.includes("vitest run"))
        return {
          exitCode: 1,
          stdout: "no json here",
          stderr: "segfault",
          timedOut: false,
        };
      if (cmd.startsWith("node -e")) return ok(SUMMARY_JSON);
      return ok("");
    });
    const result = (await execute({ test_file: "t.test.ts" }, {})) as Record<
      string,
      unknown
    >;
    expect(result["parseError"]).toBe(true);
    expect(result["passed"]).toBe(false);
    expect(result["stderrTail"]).toContain("segfault");
    // The trace still rides along when it parsed.
    expect(result["executedPath"]).toBeDefined();
  });

  it("caps max_files at the verbose ceiling", async () => {
    const { execute, commands } = makeTraceTool((cmd) => {
      if (cmd.includes("vitest run")) return ok(VITEST_FAIL_JSON);
      return ok(SUMMARY_JSON);
    });
    await execute({ test_file: "t.test.ts", max_files: 999 }, {});
    const summarize = commands.find((c) => c.startsWith("node -e"))!;
    expect(summarize.endsWith(` ${TRACE_FILE_CAPS.verbose}`)).toBe(true);
  });
});
