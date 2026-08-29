/**
 * Regression coverage for two turn-level defects:
 *
 * 1. The ENHANCE stage's code-graph pass had no timeout bound in the
 *    interactive REPL (`enhanceTimeoutMs` was never passed to `runTurn`, so
 *    it stayed `undefined` ⇒ unbounded per the pipeline's contract). On a cold
 *    tree-sitter build this hangs the turn on "thinking…" indefinitely.
 *    one-shot.ts's headless path already bounds it at 15s by default; the
 *    fix mirrors that default into the interactive path too.
 *
 * 2. A PERMANENT error (bad API key, no credit balance, auth/billing 4xx)
 *    must be surfaced to the user immediately — message shown, busy/"thinking"
 *    state cleared — never left as a silently hung spinner.
 *
 * Both are exercised through the same mocked-`runTurn` REPL harness used by
 * interactive.pump-resilience.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";

interface RunTurnResultLike {
  text: string;
  messages: unknown[];
  usage: Record<string, number>;
  trace: Record<string, unknown>;
}

interface RunTurnOptsLike {
  prompt: string;
  enhanceTimeoutMs?: number;
  [key: string]: unknown;
}

const pending: Array<{
  opts: RunTurnOptsLike;
  resolve: (v: RunTurnResultLike) => void;
  reject: (e: unknown) => void;
}> = [];
const runTurnSpy = vi.fn<(opts: RunTurnOptsLike) => void>();

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
  runTurn: (opts: RunTurnOptsLike) =>
    new Promise<RunTurnResultLike>((resolve, reject) => {
      runTurnSpy(opts);
      pending.push({ opts, resolve, reject });
    }),
}));

vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: () => null,
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

// Ink mount of the real ReplApp (model-roles resolution, plan-turn wiring,
// memory recall) plus several parallel Ink suites contending for a loaded
// 2-core CI runner can push the time-to-first-runTurn well past the stock 3s
// poll / 5s vitest ceiling. Both are raised generously — these are
// deterministic mocked-runTurn assertions, so the extra budget only affects how
// long a genuine hang takes to surface, never a passing run.
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

describe("REPL enhanceTimeoutMs wiring", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
    delete process.env["OXAGEN_ENHANCE_TIMEOUT_MS"];
  });
  afterEach(() => {
    delete process.env["OXAGEN_ENHANCE_TIMEOUT_MS"];
  });

  it("defaults to 15000ms so a cold code-graph build can't hang the turn unbounded", async () => {
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();

    await submit(stdin, "do something");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    expect(runTurnSpy.mock.calls[0]?.[0]?.enhanceTimeoutMs).toBe(15_000);
    pending[0]?.resolve({ text: "done", messages: [], usage: {}, trace: {} });
  });

  it("honors OXAGEN_ENHANCE_TIMEOUT_MS when set", async () => {
    process.env["OXAGEN_ENHANCE_TIMEOUT_MS"] = "5000";
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();

    await submit(stdin, "do something");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    expect(runTurnSpy.mock.calls[0]?.[0]?.enhanceTimeoutMs).toBe(5000);
    pending[0]?.resolve({ text: "done", messages: [], usage: {}, trace: {} });
  });

  it("disables the bound when OXAGEN_ENHANCE_TIMEOUT_MS=0", async () => {
    process.env["OXAGEN_ENHANCE_TIMEOUT_MS"] = "0";
    const { stdin } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();

    await submit(stdin, "do something");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    expect(runTurnSpy.mock.calls[0]?.[0]?.enhanceTimeoutMs).toBeUndefined();
    pending[0]?.resolve({ text: "done", messages: [], usage: {}, trace: {} });
  });
});

describe("REPL permanent-error surfacing", () => {
  beforeEach(() => {
    pending.length = 0;
    runTurnSpy.mockClear();
  });

  it("surfaces a permanent (credit-balance) error and clears the thinking/busy state, without retrying", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    await submit(stdin, "do something");
    await waitFor(() => runTurnSpy.mock.calls.length === 1);

    // While the turn is in flight, the busy/"thinking" indicator is showing.
    await waitFor(() => (lastFrame() ?? "").includes("Thinking"));

    pending[0]?.reject(
      new Error(
        "A positive credit balance is required for all requests, please add credits.",
      ),
    );

    // The error message reaches the transcript...
    await waitFor(() =>
      (lastFrame() ?? "").includes("positive credit balance"),
    );
    // ...and the busy/"thinking" indicator is cleared, not left hung.
    await waitFor(() => !(lastFrame() ?? "").includes("Thinking"));

    // Never retried: exactly one runTurn call for the one submitted prompt.
    expect(runTurnSpy).toHaveBeenCalledTimes(1);
  });
});
