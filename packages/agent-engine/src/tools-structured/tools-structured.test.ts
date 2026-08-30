import { describe, it, expect } from "vitest";
import { MemoryWorkspace } from "../workspaces/memory";
import { buildStructuredTools } from "./index";
import { buildWorkspaceTools } from "../tools";
import type { CodingEvent } from "../types";

// AI SDK tool().execute returns the tool's structured result. Cast through
// unknown to a record so assertions can read fields without `any`.
async function run(
  tool: unknown,
  input: unknown,
): Promise<Record<string, unknown>> {
  const t = tool as { execute: (i: unknown, o: unknown) => Promise<unknown> };
  return (await t.execute(input, {})) as Record<string, unknown>;
}

const PASSING_VITEST = JSON.stringify({
  numPassedTests: 2,
  numFailedTests: 0,
  testResults: [
    {
      name: "/repo/src/foo.test.ts",
      startTime: 0,
      endTime: 50,
      assertionResults: [],
    },
  ],
});

describe("buildStructuredTools", () => {
  it("exposes exactly the five model-facing tool names", () => {
    const tools = buildStructuredTools(new MemoryWorkspace({}));
    expect(Object.keys(tools).sort()).toEqual([
      "build_package_run",
      "git_diff_summarize",
      "test_trace_run",
      "test_unit_run",
      "workspace_health_check",
    ]);
  });

  it("are wired into buildWorkspaceTools in BOTH read-write and read-only modes", () => {
    const rw = buildWorkspaceTools(new MemoryWorkspace({}));
    const ro = buildWorkspaceTools(new MemoryWorkspace({}), { readOnly: true });
    for (const name of [
      "test_unit_run",
      "build_package_run",
      "git_diff_summarize",
      "workspace_health_check",
    ]) {
      expect(rw[name], `${name} in read-write`).toBeDefined();
      expect(ro[name], `${name} in read-only`).toBeDefined();
    }
    // Mutating tools are still withheld in read-only.
    expect(ro["bash"]).toBeUndefined();
  });
});

describe("test_unit_run", () => {
  it("selects the sibling test for a changed file and returns a typed pass summary", async () => {
    const ws = new MemoryWorkspace({
      "src/foo.ts": "export const x = 1;",
      "src/foo.test.ts": 'import { x } from "./foo";',
    });
    let ran = "";
    ws.onExec((cmd) => {
      ran = cmd;
      return {
        exitCode: 0,
        stdout: PASSING_VITEST,
        stderr: "",
        timedOut: false,
      };
    });
    const events: CodingEvent[] = [];
    const tools = buildStructuredTools(ws, { onEvent: (e) => events.push(e) });
    const out = await run(tools.test_unit_run, {
      changedFiles: ["src/foo.ts"],
    });
    expect(out.selected).toEqual(["src/foo.test.ts"]);
    expect(out.passed).toBe(2);
    expect(out.failed).toBe(0);
    expect(ran).toContain("src/foo.test.ts");
    expect(ran).toContain("--reporter=json");
    expect(events.some((e) => e.type === "command")).toBe(true);
  });

  it("refuses a whole-repo run: empty selection with no package returns a hint", async () => {
    const ws = new MemoryWorkspace({});
    let called = false;
    ws.onExec(() => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const out = await run(buildStructuredTools(ws).test_unit_run, {});
    expect(out.selected).toEqual([]);
    expect(out.hint).toContain("never runs the whole repo");
    expect(called).toBe(false); // never shelled out
  });

  it("rejects scope.all as a whole-repo run", async () => {
    const ws = new MemoryWorkspace({});
    let called = false;
    ws.onExec(() => {
      called = true;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const out = await run(buildStructuredTools(ws).test_unit_run, {
      scope: { all: true },
    });
    expect(out.hint).toContain("never runs the whole repo");
    expect(called).toBe(false);
  });

  it("runs one package's suite when scope.package is given with no changedFiles", async () => {
    const ws = new MemoryWorkspace({});
    let ran = "";
    ws.onExec((cmd) => {
      ran = cmd;
      return {
        exitCode: 0,
        stdout: PASSING_VITEST,
        stderr: "",
        timedOut: false,
      };
    });
    const out = await run(buildStructuredTools(ws).test_unit_run, {
      scope: { package: "@oxagen/foo" },
    });
    expect(out.passed).toBe(2);
    expect(ran).toContain("--filter '@oxagen/foo'");
  });
});

describe("build_package_run", () => {
  it("returns status ok with no raw output on a clean typecheck", async () => {
    const ws = new MemoryWorkspace({});
    let ran = "";
    ws.onExec((cmd) => {
      ran = cmd;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const out = await run(buildStructuredTools(ws).build_package_run, {
      scope: { package: "@oxagen/foo" },
    });
    expect(out.status).toBe("ok");
    expect(out.errorCount).toBe(0);
    expect(ran).toContain(
      "--filter '@oxagen/foo' exec tsc --noEmit --pretty false",
    );
  });

  it("parses and caps tsc errors on failure", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({
      exitCode: 2,
      stdout: "src/a.ts(1,1): error TS2304: Cannot find name 'foo'.",
      stderr: "",
      timedOut: false,
    }));
    const out = await run(buildStructuredTools(ws).build_package_run, {});
    expect(out.status).toBe("fail");
    expect(out.errorCount).toBe(1);
    expect((out.errors as unknown[]).length).toBe(1);
  });

  it("typechecks an explicit file list when scope.files is given", async () => {
    const ws = new MemoryWorkspace({});
    let ran = "";
    ws.onExec((cmd) => {
      ran = cmd;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    await run(buildStructuredTools(ws).build_package_run, {
      scope: { files: ["src/a.ts", "src/b.ts"] },
    });
    expect(ran).toContain("tsc --noEmit --pretty false 'src/a.ts' 'src/b.ts'");
  });
});

describe("git_diff_summarize", () => {
  it("summarizes the diff from numstat + U0 into a typed per-file overview", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec((cmd) => {
      if (cmd.includes("--numstat")) {
        return {
          exitCode: 0,
          stdout: "5\t1\tsrc/a.ts",
          stderr: "",
          timedOut: false,
        };
      }
      // -U0
      return {
        exitCode: 0,
        stdout: [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1,0 +1,5 @@ export function doThing() {",
        ].join("\n"),
        stderr: "",
        timedOut: false,
      };
    });
    const out = await run(buildStructuredTools(ws).git_diff_summarize, {});
    const files = out.files as Array<{
      path: string;
      additions: number;
      symbols: string[];
    }>;
    expect(files[0]).toMatchObject({
      path: "src/a.ts",
      additions: 5,
      symbols: ["doThing"],
    });
    expect(out.totals).toMatchObject({ files: 1, additions: 5, deletions: 1 });
  });

  it("reports no changes without error when the diff is empty", async () => {
    const ws = new MemoryWorkspace({});
    ws.onExec(() => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }));
    const out = await run(buildStructuredTools(ws).git_diff_summarize, {
      ref: "main",
    });
    expect(out.files).toEqual([]);
    expect(out.note).toContain("No changes vs main");
  });
});

describe("workspace_health_check", () => {
  it("returns a git snapshot by default without running typecheck/lint", async () => {
    const ws = new MemoryWorkspace({});
    const seen: string[] = [];
    ws.onExec((cmd) => {
      seen.push(cmd);
      return {
        exitCode: 0,
        stdout:
          "# branch.head feat/x\n# branch.upstream origin/feat/x\n# branch.ab +1 -0\n1 .M N... x x x a b src/a.ts",
        stderr: "",
        timedOut: false,
      };
    });
    const out = await run(buildStructuredTools(ws).workspace_health_check, {});
    expect(out.git).toMatchObject({
      branch: "feat/x",
      ahead: 1,
      behind: 0,
      dirtyFiles: 1,
    });
    expect(out.typecheck).toBeUndefined();
    expect(seen.every((c) => c.startsWith("git status"))).toBe(true);
  });

  it("scopes the opt-in typecheck to a package", async () => {
    const ws = new MemoryWorkspace({});
    const seen: string[] = [];
    ws.onExec((cmd) => {
      seen.push(cmd);
      if (cmd.startsWith("git"))
        return {
          exitCode: 0,
          stdout: "# branch.head main",
          stderr: "",
          timedOut: false,
        };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; // clean typecheck
    });
    const out = await run(buildStructuredTools(ws).workspace_health_check, {
      checks: ["typecheck"],
      scope: { package: "@oxagen/foo" },
    });
    expect(out.typecheck).toMatchObject({ status: "pass", errorCount: 0 });
    expect(
      seen.some((c) => c.includes("--filter '@oxagen/foo' exec tsc")),
    ).toBe(true);
  });
});
