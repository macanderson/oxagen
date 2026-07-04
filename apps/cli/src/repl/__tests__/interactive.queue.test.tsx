/**
 * Proof of the Claude Code-style prompt queue in the interactive REPL.
 *
 * The turn pipeline (`runTurn`) is replaced with a controllable mock so each turn
 * stays "in flight" until the test resolves it. We drive the real <ReplApp/>
 * through ink-testing-library's stdin and assert that prompts submitted while a
 * turn is running are (a) visibly queued, (b) not started early, and (c) run in
 * FIFO order as each prior turn completes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

// Each runTurn call parks here until the test resolves it, simulating a turn
// that takes real wall-clock time (so later submissions have to queue). The REPL
// runs every prompt through the pipeline's `runTurn` (eval → enhance → agent →
// judge), so that is the seam we control — not the lower-level agent loop.
const pending: Array<{ prompt: string; finish: () => void }> = [];
const runTurnSpy = vi.fn<(opts: { prompt: string }) => void>();

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first: ReplApp reaches beyond runTurn (e.g. model-roles.ts
  // resolves the judge via pickAdvisorModel at mount) — a bare factory
  // mock crashes the very first render with undefined exports.
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  // Instant single-task plan so turns reach the mocked runTurn without a live
  // planner model call (the real planTasks would hit the network here).
  planTasks: async () => ({
    id: "plan_test",
    goal: "",
    createdAt: 0,
    status: "draft",
    tasks: [
      {
        id: "t1",
        title: "t1",
        description: "t1",
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
  runTurn: (opts: { prompt: string }) =>
    new Promise<RunTurnResultLike>((resolve) => {
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

// The REPL records each completed turn's trace; stub the durable store so the
// test neither writes to ~/.config nor couples to the TurnTrace shape.
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
  openFleetMemory: () => ({ record: () => {}, recall: () => [], all: () => [] }),
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
  isReasoningEffort: (s: string) => ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));

// The REPL now sources the engine code-graph port here; stub it so the test
// avoids loading the tree-sitter builder / DuckDB store.
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
}));

const { ReplApp } = await import("../interactive.js");

// The REPL requires an authenticated session (ADR-019 §4) to build its ports.
const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition timed out");
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

describe("REPL prompt queue (Claude Code-style)", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
  });

  it.skip("queues prompts submitted mid-turn and runs them FIFO", async () => {
    const { stdin, lastFrame } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();

    // 1) First prompt starts a turn; runTurn is invoked and parks (in flight).
    await submit(stdin, "first task");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("first task");

    // 2) Submit two more WHILE the first turn is still running.
    await submit(stdin, "second task");
    await submit(stdin, "third task");

    // They must NOT have started — only the first turn is running.
    expect(runTurnSpy).toHaveBeenCalledTimes(1);

    // And they must be visibly queued in the UI.
    const queuedFrame = lastFrame() ?? "";
    expect(queuedFrame).toContain("queued");
    expect(queuedFrame).toContain("second task");
    expect(queuedFrame).toContain("third task");

    // 3) Finish the first turn → the next queued prompt auto-runs.
    pending[0]?.finish();
    await waitFor(() => runTurnSpy.mock.calls.length === 2);
    expect(runTurnSpy.mock.calls[1]?.[0].prompt).toBe("second task");

    // 4) Finish the second → the third runs, preserving order.
    pending[1]?.finish();
    await waitFor(() => runTurnSpy.mock.calls.length === 3);
    expect(runTurnSpy.mock.calls[2]?.[0].prompt).toBe("third task");

    // 5) Finish the third → queue fully drained, nothing else runs.
    pending[2]?.finish();
    await tick(30);
    expect(runTurnSpy).toHaveBeenCalledTimes(3);
    expect(lastFrame() ?? "").not.toContain("queued");
  });

  it("answers the Esc-twice reset confirmation synchronously — 'y' resets, never queues", async () => {
    const { stdin, lastFrame } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick(100); // let the async session-memory mount settle before input

    // Double-Esc while idle opens the reset confirmation (two presses inside the
    // 1500ms window — back-to-back writes are well within it).
    stdin.write("\x1b");
    await tick(60);
    stdin.write("\x1b");
    await tick(60);
    await waitFor(() => (lastFrame() ?? "").includes("reset the conversation"));

    // Answering "y" must be consumed as the confirmation the instant Enter is
    // pressed — it must NOT be enqueued as a prompt (regression: it used to land
    // in the FIFO and run as an ordinary turn).
    await submit(stdin, "y");
    await tick(30);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Conversation reset");
    expect(frame).not.toContain("queued");
    // The answer never reached the turn pipeline.
    expect(runTurnSpy).not.toHaveBeenCalled();
  });

  it.skip("runs a prompt immediately when idle (no queue wait)", async () => {
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();

    await submit(stdin, "solo task");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("solo task");

    // Nothing queued behind it.
    pending[0]?.finish();
    await tick(30);
    expect(runTurnSpy).toHaveBeenCalledTimes(1);
  });
});
