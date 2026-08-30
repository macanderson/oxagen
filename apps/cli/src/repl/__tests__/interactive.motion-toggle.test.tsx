/**
 * `/motion` — the animation-level command. Proves the REPL handler:
 *   • reports the current mode when called with no argument,
 *   • sets and persists full|reduced|off (via setMotionMode),
 *   • accepts "on" as a natural alias for full,
 *   • rejects an unknown mode without changing anything,
 *   • tracks the CURRENT mode across repeated invocations (motionRef — the
 *     same stale-closure trap /mouse fell into; handleSubmit's deps don't
 *     include the motion state).
 *
 * lib/config.js is partially mocked so setMotionMode never writes the
 * developer's real ~/.config/oxagen/config.json.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

// `runTurn` is never reached by `/motion` (it returns before any turn starts),
// but the module must still resolve for `ReplApp` to mount.
vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first: ReplApp reaches beyond runTurn (e.g. model-roles.ts
  // resolves the judge via pickAdvisorModel at mount) — a bare factory
  // mock crashes the very first render with undefined exports.
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  runTurn: () =>
    new Promise(() => {
      /* never settles — no test here exercises a real turn */
    }),
}));

vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: () => null,
}));

// Skip the first-turn project-init prompt so `/motion` is handled deterministically.
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

// Keep every other config getter real (session resolution etc. relies on
// them) but stub the motion pair: reads start at "full", writes are recorded
// instead of touching the real user config file on disk.
const setMotionModeSpy = vi.hoisted(() => vi.fn());
vi.mock("../../lib/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/config.js")>();
  return {
    ...actual,
    getMotionMode: (): string => "full",
    setMotionMode: setMotionModeSpy,
  };
});

const { ReplApp } = await import("../interactive.js");

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

describe("REPL /motion command", () => {
  beforeEach(() => {
    setMotionModeSpy.mockClear();
  });

  it("reports the current mode, sets+persists new modes, tracks across invocations, and rejects junk", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    const countOf = (needle: string): number =>
      (lastFrame() ?? "").split(needle).length - 1;

    // Bare /motion reports the seeded mode without persisting anything.
    await submit(stdin, "/motion");
    await waitFor(() => countOf("Motion: full") >= 1);
    expect(setMotionModeSpy).not.toHaveBeenCalled();

    // Set reduced — confirmed and persisted.
    await submit(stdin, "/motion reduced");
    await waitFor(() => countOf("Motion REDUCED") >= 1);
    expect(setMotionModeSpy).toHaveBeenLastCalledWith("reduced");

    // The bare readout must now track the NEW mode (motionRef, not a stale
    // closure over the mount-time state).
    await submit(stdin, "/motion");
    await waitFor(() => countOf("Motion: reduced") >= 1);

    // Set off, then back to full via the "on" alias.
    await submit(stdin, "/motion off");
    await waitFor(() => countOf("Motion OFF") >= 1);
    expect(setMotionModeSpy).toHaveBeenLastCalledWith("off");

    await submit(stdin, "/motion on");
    await waitFor(() => countOf("Motion FULL") >= 1);
    expect(setMotionModeSpy).toHaveBeenLastCalledWith("full");

    // An unknown mode is rejected and nothing is persisted for it.
    const persistCalls = setMotionModeSpy.mock.calls.length;
    await submit(stdin, "/motion sideways");
    await waitFor(() => countOf("Unknown motion mode") >= 1);
    expect(setMotionModeSpy.mock.calls.length).toBe(persistCalls);
  });
});
