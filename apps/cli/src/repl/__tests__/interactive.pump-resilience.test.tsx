/**
 * Regression: a single failing turn must not wedge the prompt queue.
 *
 * The pump drains queued prompts one at a time inside a single loop. If a turn
 * throws (e.g. slash expansion fails before the model call), the throw must be
 * contained — the remaining prompts queued behind it still run, and nothing
 * escapes as an unhandled rejection from the `void pump()` call site.
 *
 * We park `runTurn` so prompts queue behind an in-flight turn, make the second
 * queued item throw during slash expansion, and assert the third still runs.
 * On the pre-fix code the throw breaks the drain loop and the third prompt is
 * abandoned.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

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

// The failing seam: expanding "/boom" throws, so handleSubmit rejects before it
// reaches runTurn — exactly the kind of error that must not break the drain.
vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: (text: string) => {
    if (text === "/boom") throw new Error("kaboom");
    return null;
  },
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
// The REPL now wires the engine code-graph port from this module; stub it so the
// test neither loads the tree-sitter builder nor touches the DuckDB store.
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  // Mount-time warm-up (PR #654): a missing export here crashes ReplApp at
  // mount and every waitFor starves on empty frames — keep in sync.
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

// Minimal authenticated session — the REPL requires one (ADR-019 §4) to build
// the platform AI and memory ports.
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

describe("REPL pump resilience", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
  });

  it("keeps draining the queue after a turn throws", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    // 1) First prompt starts a turn and parks (in flight).
    await submit(stdin, "first task");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    // 2) Queue a failing slash command and a real prompt behind it.
    await submit(stdin, "/boom");
    await submit(stdin, "third task");

    // 3) Finish the first turn → pump drains "/boom" (throws) then "third task".
    pending[0]?.finish();

    // The real prompt queued behind the failing one must still run.
    await waitFor(() =>
      runTurnSpy.mock.calls.some((c) => c[0].prompt === "third task"),
    );
    expect(
      runTurnSpy.mock.calls.some((c) => c[0].prompt === "third task"),
    ).toBe(true);

    // And the failure was surfaced, not swallowed.
    expect(lastFrame() ?? "").toContain("kaboom");
  });
});
