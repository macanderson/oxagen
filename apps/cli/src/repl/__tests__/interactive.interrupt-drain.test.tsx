/**
 * Regression: interrupting a turn (Esc) must not wedge the prompt queue.
 *
 * The reported bug: after pressing Esc to interrupt the running agent, newly
 * submitted prompts just pile up as "queued" and never run. Root cause — the
 * pump was parked on `await handleSubmit(cancelledTurn)`, and the aborted turn's
 * stream can be slow (or, if it ignores the abort, never) to settle. Until it
 * did, the re-entrancy guard (`pumpingRef`) blocked every later prompt.
 *
 * We simulate exactly that by making `runTurn` park forever (the mock never
 * resolves the interrupted turn). On the fixed code, the pump orphans the stuck
 * turn on Esc and continues draining the queue oldest-first; a prompt submitted
 * after the interrupt still runs. On the pre-fix code it never does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

// Each runTurn parks until the test resolves it (or, for the interrupted turn,
// forever — simulating a stream that does not settle promptly on abort).
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
            trace: {},
          }),
      });
    }),
}));

// Skip the first-turn project-init prompt so turns reach runTurn deterministically.
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
  explicitModelId: (override?: string) => override ?? undefined,
  resolveEffort: () => undefined,
  isReasoningEffort: (s: string) =>
    ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  // Mount-time warm-up: a missing export here crashes ReplApp at mount and
  // every waitFor starves on empty frames — keep in sync.
  warmCodeGraph: () => {},
}));

// Planning fires a REAL structured-output LLM call (and the memory recall
// before it) on every turn — a unit test must never drive that. Degrade to
// the same synchronous fallback plan a planner failure produces, which keeps
// the single-task -> runTurn flow these tests assert on.
vi.mock("../plan-turn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-turn.js")>();
  return {
    ...actual,
    planReplTurn: async ({ goal }: { goal: string }) =>
      actual.fallbackPlan(goal),
  };
});

const { ReplApp } = await import("../interactive.js");

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

// Ink mount of the real ReplApp plus the multi-stage submit/interrupt/drain
// choreography, contending with other parallel Ink suites on a loaded 2-core CI
// runner, can run well past the stock 3s poll / 5s vitest ceiling. The runTurn
// mock is deterministic, so raising both generously keeps these green without
// weakening any assertion (the pump's queue-drain behaviour is still fully
// exercised).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error("waitFor: condition timed out");
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

const ran = (prompt: string): boolean =>
  runTurnSpy.mock.calls.some((c) => c[0].prompt === prompt);

describe("REPL interrupt does not wedge the queue", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
  });

  it("drains the queue oldest-first after Esc, even when the interrupted turn never settles", async () => {
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick(50);

    // 1) First prompt starts a turn and parks (it will NEVER be finished —
    //    modelling a stream that does not unwind promptly on abort).
    await submit(stdin, "first task");
    await waitFor(() => ran("first task"));

    // 2) Queue two more behind it while it is in flight.
    await submit(stdin, "second task");
    await submit(stdin, "third task");
    expect(runTurnSpy).toHaveBeenCalledTimes(1); // still only the first is running

    // 3) Interrupt with Esc. The pre-fix bug: the pump stays parked on the
    //    (never-settling) first turn, so nothing else ever runs.
    stdin.write("\x1b");

    // 4) The queued prompts must now drain oldest-first — "second task" runs
    //    without the interrupted turn ever finishing.
    await waitFor(() => ran("second task"));
    expect(
      runTurnSpy.mock.calls.find((c) => c[0].prompt === "second task"),
    ).toBeTruthy();

    // 5) Finish "second task" → "third task" runs next, preserving order.
    pending.find((p) => p.prompt === "second task")?.finish();
    await waitFor(() => ran("third task"));
  });

  it("keeps accepting new prompts after an interrupt with an empty queue", async () => {
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick(50);

    // A single turn in flight, nothing queued behind it.
    await submit(stdin, "solo task");
    await waitFor(() => ran("solo task"));

    // Interrupt it — the queue is empty, so the agent should simply return to
    // idle and wait for the next prompt.
    stdin.write("\x1b");
    await tick(30);

    // A brand-new prompt typed after the interrupt must run (not get stuck as
    // "queued" behind the never-settling interrupted turn).
    await submit(stdin, "next task");
    await waitFor(() => ran("next task"));
    expect(
      runTurnSpy.mock.calls.find((c) => c[0].prompt === "next task"),
    ).toBeTruthy();
  });
});
