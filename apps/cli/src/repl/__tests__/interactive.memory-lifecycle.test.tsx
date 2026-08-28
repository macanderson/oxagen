/**
 * Regression: the REPL must not leak its session-memory handle when it unmounts
 * before `openSessionMemory` resolves.
 *
 * The mount effect opens session memory asynchronously. If the component
 * unmounts while that open is still in flight, the effect's cleanup runs with
 * the local handle still `null` and cannot close anything — so without a
 * cancellation guard the SessionMemory (and its DuckDB connection) that resolves
 * afterwards is never closed and leaks for the life of the process.
 *
 * This test parks `openSessionMemory`, unmounts, then resolves the open and
 * asserts the handle's `close()` is called. Fails on the pre-fix code (close is
 * never invoked), passes once the effect closes a post-unmount handle.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";

interface SessionMemoryLike {
  remember: () => Promise<void>;
  recallContext: () => Promise<string>;
  close: () => Promise<void>;
}

let resolveOpen: ((m: SessionMemoryLike) => void) | undefined;
const closeSpy = vi.fn(async () => {});

vi.mock("../../agent/memory.js", () => ({
  openSessionMemory: () =>
    new Promise<SessionMemoryLike>((resolve) => {
      resolveOpen = resolve as (m: SessionMemoryLike) => void;
    }),
}));

// Keep the rest of the REPL inert so the test exercises only the memory lifecycle.
vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first: ReplApp reaches beyond runTurn (e.g. model-roles.ts
  // resolves the judge via pickAdvisorModel at mount) — a bare factory
  // mock crashes the very first render with undefined exports.
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  runTurn: () => new Promise<never>(() => {}),
}));
// Stub the engine code-graph port source so the test doesn't load the
// tree-sitter builder or touch the DuckDB store.
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  // Mount-time warm-up: a missing export here crashes ReplApp at mount and
  // every waitFor starves on empty frames — keep in sync.
  warmCodeGraph: () => {},
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

describe("REPL session-memory lifecycle", () => {
  it("closes a session-memory handle that resolves after unmount", async () => {
    closeSpy.mockClear();

    const { unmount } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick();
    // The async open is still parked — unmount before it resolves. Read through
    // a typed alias so control-flow analysis doesn't narrow the mock-assigned
    // `resolveOpen` away.
    const resolve = resolveOpen as
      | ((m: SessionMemoryLike | null) => void)
      | undefined;
    expect(resolve).toBeTypeOf("function");

    unmount();
    await tick();

    // Now the open lands after unmount: the effect must close it, not leak it.
    resolve?.({
      remember: async () => {},
      recallContext: async () => "",
      close: closeSpy,
    });
    await tick();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
