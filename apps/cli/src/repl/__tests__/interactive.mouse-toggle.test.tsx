/**
 * Regression: `/mouse` must flip repeatedly (OFF→ON→OFF→ON), not get stuck
 * after one toggle.
 *
 * `handleSubmit` (which handles `/mouse` inline) is a `useCallback` whose deps
 * don't include the `mouseOn` state — reading it directly inside the handler
 * closes over whatever value it had when the callback was last memoized, so
 * `!mouseOn` kept recomputing the SAME flip on every subsequent `/mouse` call.
 * The fix mirrors `mouseOn` into a ref (the same pattern already used for
 * `hudVisibleRef`/`panelModeRef`) so the handler always reads the latest value.
 *
 * Mouse reporting now defaults OFF (so native terminal copy/paste works out of
 * the box), so the FIRST toggle turns it ON.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

// `runTurn` is never reached by `/mouse` (it returns before any turn starts),
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

// Skip the first-turn project-init prompt so `/mouse` is handled deterministically.
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

describe("REPL /mouse toggle", () => {
  beforeEach(() => {
    delete process.env["OXAGEN_CLI_MOUSE"];
  });

  it("flips OFF -> ON -> OFF across repeated invocations, not stuck after one toggle", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick();

    const countOf = (needle: string): number =>
      (lastFrame() ?? "").split(needle).length - 1;

    // Starts OFF (default, OXAGEN_CLI_MOUSE unset), so the first toggle turns it ON.
    await submit(stdin, "/mouse");
    await waitFor(() => countOf("Mouse-wheel scroll ON") >= 1);

    // Second toggle must turn it back OFF — on the stale-closure bug this
    // recomputed `!mouseOn` against the FIRST render's value and reported ON
    // again instead of flipping back, so "Mouse-wheel scroll OFF" would never
    // reappear and this wait would time out.
    await submit(stdin, "/mouse");
    await waitFor(() => countOf("Mouse-wheel scroll OFF") >= 1);

    // Third toggle must turn it ON again — confirms the ref keeps tracking
    // correctly across more than one flip, not just recovering once. Asserted
    // as a growing occurrence count (rather than string position) so it holds
    // regardless of whether the transcript's Static history accumulates past
    // messages into the same frame.
    const onCountBeforeThirdToggle = countOf("Mouse-wheel scroll ON");
    await submit(stdin, "/mouse");
    await waitFor(
      () => countOf("Mouse-wheel scroll ON") > onCountBeforeThirdToggle,
    );
  });
});
