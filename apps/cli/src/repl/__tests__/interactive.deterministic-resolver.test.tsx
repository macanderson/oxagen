/**
 * Wire-up coverage for the deterministic turn resolver seam in ReplApp
 * (interactive.tsx → resolveDeterministicTurn, "determinism before
 * intelligence"). The pure matcher is unit-tested in
 * ../deterministic-resolver.test.ts; THIS file proves the REPL wiring:
 *
 *   1. a template-solvable submission writes the artifact to disk through the
 *      gated workspace (default mode `acceptEdits` auto-allows file writes),
 *   2. the transcript shows the deterministic completion message, and
 *   3. the engine (`runTurn`) is NEVER invoked — zero model calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Spy on the engine: the deterministic path must never reach it. Spread the
// real module — a full-replacement mock would drop exports that sibling REPL
// modules (plan-turn's planTasks, fleet) import at load time.
const runTurnSpy = vi.fn(async () => {
  throw new Error("runTurn must not be called for a deterministic turn");
});
vi.mock("@oxagen/agent-engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/agent-engine")>();
  return { ...real, runTurn: runTurnSpy };
});

// Baseline inert-mount mock set, same as the other interactive.*.test.tsx
// harnesses (cli-inline-dispatch, memory-lifecycle).
vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: () => null,
  parseInvocation: () => null,
}));
vi.mock("../../project/init.js", () => ({
  isProjectInitialized: () => true,
  initializeProject: async () => true,
}));
vi.mock("../../agent/trace-store.js", () => ({
  openTraceStore: () => ({
    record: () => {},
    get: () => undefined,
    list: () => [],
    last: () => undefined,
    resolve: () => undefined,
  }),
}));
vi.mock("../../agent/fleet/memory.js", () => ({
  openFleetMemory: () => ({
    record: () => {},
    recall: () => [],
    all: () => [],
  }),
}));
vi.mock("../../agent/memory.js", () => ({
  openSessionMemory: async () => ({
    remember: async () => {},
    recallContext: async () => "",
    close: async () => {},
  }),
}));
vi.mock("../../agent/project-context.js", () => ({
  loadProjectContext: () => ({ text: "", sources: [] }),
}));
vi.mock("../../agent/model.js", () => ({
  resolveModelId: (override?: string) => override ?? "test/model",
  resolveEffort: () => undefined,
  isReasoningEffort: (s: string) =>
    ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  warmCodeGraph: () => {},
}));

const { ReplApp } = await import("../interactive.js");
const { buildProgram } = await import("../../program.js");

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() - deadline > 0)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
  }
}

async function submit(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick();
}

describe("REPL deterministic turn resolver — .gitignore with zero model calls", () => {
  let workDir: string;
  let realCwd: string;

  beforeEach(async () => {
    realCwd = process.cwd();
    // ReplApp captures process.cwd() at mount; point it at an empty temp repo
    // so the resolver's fileExists probe and the gated write both land there.
    workDir = await mkdtemp(join(tmpdir(), "oxagen-det-"));
    process.chdir(workDir);
    runTurnSpy.mockClear();
  });

  afterEach(async () => {
    process.chdir(realCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes the composed .gitignore, shows the summary, and never calls runTurn", async () => {
    // acceptEdits: file writes auto-allow. In the default `ask` mode the
    // deterministic write goes through the SAME approval prompt as any engine
    // write — gated, but still zero model calls.
    const { stdin, lastFrame } = render(
      <ReplApp
        options={{ session: TEST_SESSION, buildProgram, mode: "acceptEdits" }}
      />,
    );
    await tick();

    await submit(stdin, "create a .gitignore optimized for mac osx and python");
    await until(() => (lastFrame() ?? "").includes("Created .gitignore"));

    // Single-token assertions: Ink wraps long lines at spaces, so multi-word
    // phrases can be split across rendered rows. Disk + spy are the real proof.
    const frame = lastFrame() ?? "";
    expect(frame).toContain("deterministic");

    const written = await readFile(join(workDir, ".gitignore"), "utf-8");
    expect(written).toContain(".DS_Store");
    expect(written).toContain("__pycache__/");

    expect(runTurnSpy).not.toHaveBeenCalled();
  });

  it("falls through to the normal pipeline when .gitignore already exists", async () => {
    // Pre-existing file ⇒ the resolver must bail; the submission then heads
    // for the planner/engine path. runTurn is mocked to throw, and the REPL
    // surfaces turn errors instead of writing files — the file must survive
    // untouched.
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();
    const marker = "# pre-existing sentinel\n";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(workDir, ".gitignore"), marker, "utf-8");

    await submit(stdin, "create a .gitignore for python");
    // The engine path is reached (and our spy rejects it) — wait for the spy.
    await until(() => runTurnSpy.mock.calls.length > 0, 8000);

    expect(existsSync(join(workDir, ".gitignore"))).toBe(true);
    const survived = await readFile(join(workDir, ".gitignore"), "utf-8");
    expect(survived).toBe(marker);
    // And the deterministic completion message never appeared.
    expect(lastFrame() ?? "").not.toContain("Created .gitignore");
  });
});
