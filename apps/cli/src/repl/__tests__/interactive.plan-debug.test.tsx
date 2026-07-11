/**
 * Proof of /plan (plan-only mode) and /debug (runtime debug-log toggle).
 *
 * Same harness as interactive.queue.test.tsx: the engine's `planTasks` and
 * `runTurn` are mocked at the seam the REPL actually calls, so a plan-only
 * turn exercises the REAL plan gate in interactive.tsx — we assert the plan
 * renders, the tasks stay pending, and `runTurn` is never invoked until
 * `/plan run` re-submits the stored prompt with the one-shot bypass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

const runTurnSpy = vi.fn<(opts: { prompt: string }) => void>();

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first — ReplApp reaches beyond runTurn (model-roles resolves
  // the judge at mount); a bare factory mock crashes the first render.
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  // Instant single-task plan so plan-only turns render deterministically
  // without a live planner model call.
  planTasks: async (opts: { goal: string }) => ({
    id: "plan_test",
    goal: opts.goal,
    createdAt: 0,
    status: "draft",
    tasks: [
      {
        id: "t1",
        title: `planned: ${opts.goal}`,
        description: opts.goal,
        status: "queued",
        dependsOn: [],
        files: [],
        tier: "fast",
        model: "test/model",
        createdAt: 0,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      },
    ],
  }),
  runTurn: (opts: { prompt: string }): Promise<RunTurnResultLike> => {
    runTurnSpy(opts);
    return Promise.resolve({
      text: `done:${opts.prompt}`,
      messages: [],
      usage: {},
      trace: { id: `trace_${opts.prompt}` },
    });
  },
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
  explicitModelId: (override?: string) => override ?? undefined,
  resolveEffort: () => undefined,
  isReasoningEffort: (s: string) =>
    ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));

vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  warmCodeGraph: () => {},
}));

// Without this the FIRST real turn opens the ".oxagen bootstrap" consent
// overlay (no .oxagen in the test cwd) and swallows the keyboard — the same
// mock every other interactive.*.test.tsx carries.
vi.mock("../../project/init.js", () => ({
  isProjectInitialized: () => true,
  initializeProject: async () => true,
}));

const { ReplApp } = await import("../interactive.js");
const { DEBUG_ENV } = await import("../../lib/debug-log.js");

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => boolean,
  ms = 15_000,
  frame?: () => string,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error(
        `waitFor: condition timed out${frame ? `\n--- last frame ---\n${frame().slice(-2000)}` : ""}`,
      );
    await tick(10);
  }
}

/** Type `text` then press Enter into the REPL's stdin. */
async function submit(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick();
}

describe("REPL /plan plan-only mode", () => {
  beforeEach(() => {
    runTurnSpy.mockClear();
  });

  it("plans without executing, then /plan run executes the stored prompt", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    // Turn plan-only mode on.
    await submit(stdin, "/plan on");
    await waitFor(() => (lastFrame() ?? "").includes("Plan-only mode ON"));

    // A prompt now produces ONLY a plan — the mocked runTurn must never fire.
    await submit(stdin, "add a login page");
    await waitFor(
      () => (lastFrame() ?? "").includes("Plan only —"),
      15_000,
      () => lastFrame() ?? "",
    );
    expect(lastFrame() ?? "").toContain("planned: add a login page");
    expect(runTurnSpy).not.toHaveBeenCalled();

    // Status reports the stored prompt.
    await submit(stdin, "/plan status");
    await waitFor(() => (lastFrame() ?? "").includes("last planned prompt"));

    // /plan run re-submits the stored prompt with the one-shot bypass: the
    // SAME prompt now reaches runTurn even though plan-only mode is still ON.
    await submit(stdin, "/plan run");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("add a login page");
  });

  it("reports when there is no plan to run and toggles off", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    await submit(stdin, "/plan run");
    await waitFor(() => (lastFrame() ?? "").includes("No plan to run"));

    await submit(stdin, "/plan on");
    await waitFor(() => (lastFrame() ?? "").includes("Plan-only mode ON"));
    await submit(stdin, "/plan off");
    await waitFor(() => (lastFrame() ?? "").includes("Plan-only mode OFF"));
    expect(runTurnSpy).not.toHaveBeenCalled();
  });
});

describe("REPL /debug toggle", () => {
  const saved = process.env[DEBUG_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[DEBUG_ENV];
    else process.env[DEBUG_ENV] = saved;
  });

  it("flips the env-gated file log on and off for this process", async () => {
    delete process.env[DEBUG_ENV];
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    await submit(stdin, "/debug on");
    await waitFor(() => (lastFrame() ?? "").includes("Debug file log ON"));
    expect(process.env[DEBUG_ENV]).toBe("1");
    expect(lastFrame() ?? "").toContain("cli.output");

    await submit(stdin, "/debug status");
    await waitFor(() => (lastFrame() ?? "").includes("Debug file log ON"));

    await submit(stdin, "/debug off");
    await waitFor(() => (lastFrame() ?? "").includes("Debug file log OFF"));
    expect(process.env[DEBUG_ENV]).toBe("0");
  });
});
