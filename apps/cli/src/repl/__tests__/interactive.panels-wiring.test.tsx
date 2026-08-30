/**
 * Wiring proof for the takeover panels and the busy-submit triage:
 *   · Ctrl+T toggles the Task Progress inspector (and /tasks does the same)
 *   · Ctrl+S toggles the Agent Swarm view
 *   · /marketplace and /prompts open their panels
 *   · /create-command opens the scaffolding wizard
 *   · a prompt submitted mid-turn is queued, then triage's "background"
 *     verdict pulls it out of the FIFO and dispatches a detached worker
 *
 * Same harness as interactive.plan-debug.test.tsx; additionally mocks
 * ../triage.js (controllable decision) and ../../sessions/dispatch.js (no
 * real worker processes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

// runTurn parks until the test finishes it — so mid-turn submissions queue.
const pending: Array<{ prompt: string; finish: () => void }> = [];
const runTurnSpy = vi.fn<(opts: { prompt: string }) => void>();

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
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
  runTurn: (opts: { prompt: string }): Promise<RunTurnResultLike> =>
    new Promise((resolve) => {
      runTurnSpy(opts);
      pending.push({
        prompt: opts.prompt,
        finish: () =>
          resolve({
            text: `done:${opts.prompt}`,
            messages: [],
            usage: {},
            trace: { id: `trace_${opts.prompt}` },
          }),
      });
    }),
}));

// Controllable triage verdict — the REAL module never gets a model call here.
const triageDecision = vi.fn(
  async (_opts: unknown): Promise<{ route: string; reason: string }> => ({
    route: "queue",
    reason: "test default",
  }),
);
vi.mock("../triage.js", () => ({
  triagePrompt: (opts: unknown) => triageDecision(opts),
}));

// Detached-worker dispatch — never spawn a real process in tests.
const dispatchSpy = vi.fn(async (opts: { prompt: string }) => ({
  sid: `sid_${opts.prompt.slice(0, 8)}`,
  title: opts.prompt,
}));
vi.mock("../../sessions/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/dispatch.js")>()),
  dispatchDetachedSession: (opts: { prompt: string }) => dispatchSpy(opts),
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

vi.mock("../../project/init.js", () => ({
  isProjectInitialized: () => true,
  initializeProject: async () => true,
}));

const { ReplApp } = await import("../interactive.js");

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
        `waitFor: condition timed out${frame ? `\n--- last frame ---\n${frame().slice(-1500)}` : ""}`,
      );
    await tick(10);
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

const CTRL_T = "\x14";
const CTRL_S = "\x13";

describe("REPL panel keybindings + slash wiring", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
    dispatchSpy.mockClear();
    triageDecision.mockClear();
  });

  it("Ctrl+T toggles the Task Progress inspector", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();
    // useInput subscribes after commit — re-press inside the poll.
    await waitFor(() => {
      stdin.write(CTRL_T);
      return (lastFrame() ?? "").includes("Task Progress");
    });
    // Second press closes it again.
    await waitFor(() => {
      stdin.write(CTRL_T);
      return !(lastFrame() ?? "").includes("Task Progress");
    });
  });

  it("Ctrl+S toggles the Agent Swarm view; Ctrl+T switches panels", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();
    await waitFor(() => {
      stdin.write(CTRL_S);
      return (lastFrame() ?? "").includes("Agent Swarm");
    });
    // Ctrl+T while the swarm is open switches to the tasks panel (exclusive).
    await waitFor(() => {
      stdin.write(CTRL_T);
      return (
        (lastFrame() ?? "").includes("Task Progress") &&
        !(lastFrame() ?? "").includes("Agent Swarm")
      );
    });
  });

  it("/marketplace, /prompts, and /create-command open their surfaces", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    await submit(stdin, "/marketplace");
    await waitFor(
      () => (lastFrame() ?? "").includes("Marketplace"),
      15_000,
      () => lastFrame() ?? "",
    );
    stdin.write(""); // Esc closes
    await waitFor(() => !(lastFrame() ?? "").includes("Marketplace"));

    await submit(stdin, "/prompts");
    await waitFor(() => (lastFrame() ?? "").includes("Saved Prompts"));
    stdin.write("");
    await waitFor(() => !(lastFrame() ?? "").includes("Saved Prompts"));

    await submit(stdin, "/create-command");
    await waitFor(() =>
      (lastFrame() ?? "").toLowerCase().includes("slash command"),
    );
    stdin.write("");
  });

  it("busy submit queues, then a background triage verdict dispatches it", async () => {
    triageDecision.mockResolvedValueOnce({
      route: "background",
      reason: "independent of the running task",
    });
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    // Start a turn that parks in the mocked runTurn.
    await submit(stdin, "first long task");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    // Mid-turn submission → enqueued, triaged, backgrounded.
    await submit(stdin, "independent second task");
    await waitFor(
      () => dispatchSpy.mock.calls.length === 1,
      15_000,
      () => lastFrame() ?? "",
    );
    expect(dispatchSpy.mock.calls[0]?.[0].prompt).toBe(
      "independent second task",
    );
    await waitFor(() => (lastFrame() ?? "").includes("triage: backgrounded"));
    // The backgrounded prompt must never ALSO run inline.
    pending[0]?.finish();
    await tick(100);
    expect(runTurnSpy.mock.calls.map((c) => c[0].prompt)).not.toContain(
      "independent second task",
    );
  });

  it("a queue triage verdict leaves the FIFO untouched", async () => {
    triageDecision.mockResolvedValueOnce({
      route: "queue",
      reason: "depends on the running task",
    });
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    await submit(stdin, "first long task");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    await submit(stdin, "follow-up task");
    await waitFor(() => (lastFrame() ?? "").includes("follow-up task"));
    expect(dispatchSpy).not.toHaveBeenCalled();

    // Finishing the first turn lets the queued follow-up run inline, FIFO.
    pending[0]?.finish();
    await waitFor(() => runTurnSpy.mock.calls.length === 2);
    expect(runTurnSpy.mock.calls[1]?.[0].prompt).toBe("follow-up task");
    pending[1]?.finish();
  });
});
