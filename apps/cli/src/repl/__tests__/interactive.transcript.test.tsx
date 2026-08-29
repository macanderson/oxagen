/**
 * Regression guard for the REPL transcript rendering model.
 *
 * The REPL renders inline: finished messages commit to the terminal's real
 * scrollback via Ink's `<Static>` (printed once, never re-rendered), while the
 * one message still being streamed into re-renders in a small live frame below
 * it. An earlier model re-rendered the FULL message list in a live region while
 * `<Static>` ALSO committed every settled message, so once a turn finished each
 * message appeared twice — a later model dropped `<Static>` entirely to dodge
 * that bug, at the cost of native scrollback (see interactive.launch.test.tsx).
 * This file locks the invariant that survives both: a finalized assistant
 * answer renders in the transcript, and renders EXACTLY once (never in both the
 * committed and live regions at once).
 *
 * Under ink-testing-library stdout is not a TTY, so the component takes its
 * non-full-screen path — the alternate-screen takeover (or rather, the absence
 * of one) is exercised separately in interactive.launch.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

// runTurn resolves immediately with a final answer — no streaming callbacks — so
// the REPL takes the "closeStreamingBlocks → push final assistant" path and the
// answer lands as a settled (non-streaming) message, eligible for <Static>.
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
  runTurn: async (opts: { prompt: string }) => {
    runTurnSpy(opts);
    return {
      text: `answer-to:${opts.prompt}`,
      messages: [],
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
      trace: { id: "t", usage: { costUsd: 0 } },
    };
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

// Treat the project as already initialized so the first prompt goes straight to
// the turn pipeline instead of triggering the interactive init/approval gate.
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

const tick = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms)
      throw new Error("waitFor: condition timed out");
    await tick(10);
  }
}

describe("REPL transcript rendering (Static history + live frame)", () => {
  beforeEach(() => {
    runTurnSpy.mockClear();
  });

  it("commits a finalized assistant answer to the transcript output", async () => {
    const { stdin, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100); // let the async session-memory mount settle before input

    stdin.write("build the thing");
    await tick();
    stdin.write("\r");

    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    // The settled answer is committed via <Static> — assert it shows up in the
    // emitted output.
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("build the thing");
    unmount();
  });

  it("renders each finalized message exactly once — no duplication", async () => {
    // Regression: an earlier model re-rendered the FULL `messages` list in a
    // live region while <Static> ALSO committed every settled message, so once
    // a turn finished (nothing streaming) each message rendered twice. The
    // current split commits a message to <Static> XOR renders it in the live
    // frame, never both — the final frame must contain the settled answer
    // EXACTLY once. Under the old bug it appeared twice.
    const { stdin, lastFrame, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100);

    stdin.write("build the thing");
    await tick();
    stdin.write("\r");

    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    // Wait until the answer has been rendered into the transcript at least once
    // across the render history.
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    await tick(40);

    const frame = lastFrame() ?? "";
    const occurrences = frame.split("answer-to:build the thing").length - 1;
    expect(occurrences).toBe(1);
    unmount();
  });

  it("does not intercept PageUp/PageDown — scrollback is native now", async () => {
    // The REPL used to manage its own scroll offset over a windowed transcript
    // (PgUp/PgDn). That model is gone: finished messages live in the terminal's
    // real scrollback via <Static>, so the app must never react to PageUp/
    // PageDown (or show an in-app "scrolled back" hint) — the terminal handles
    // scrolling on its own, the same as it would for any other normal-buffer
    // program.
    const { stdin, lastFrame, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100);

    stdin.write("build the thing");
    await tick();
    stdin.write("\r");
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    await tick(40);

    const before = lastFrame() ?? "";
    expect(before).not.toContain("history");

    // PageUp — CSI 5 ~ (ESC [ 5 ~) — must be a no-op.
    stdin.write("\x1b[5~");
    await tick(60);
    const after = lastFrame() ?? "";
    expect(after).not.toContain("history");
    expect(after).toBe(before);
    unmount();
  });

  it("commits the persistent banner wordmark once into scrollback", async () => {
    // The sunset banner is the permanent FIRST <Static> item (see interactive.tsx),
    // so in inline mode it commits to real scrollback exactly once at open and
    // stays there for the session — never re-rendered into the live frame. This
    // is the same duplication class the "exactly once" message test guards: an
    // earlier model rendered the Banner in the live empty-state block, which — if
    // reintroduced now that it also lives in <Static> — would print it twice.
    // The banner is the gradient OXAGEN wordmark ONLY: version and org/workspace
    // scope live in the full-screen HeaderBar, so their absence here is asserted
    // too (reintroducing them under the wordmark is the duplicate-chrome bug the
    // user reported).
    const { lastFrame, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100); // let the async session-memory mount settle

    // The gradient interleaves an ANSI color escape per run (nearly per
    // column), so block rows are never contiguous in raw output — strip the
    // escapes before matching.
    const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

    // Committed to scrollback: the wordmark's first block row.
    const markRow = " ██████  ██   ██  █████   ██████  ███████ ███    ██";
    await waitFor(() => strip(frames.join("")).includes(markRow));

    // Exactly once — the banner is a single Static item, not duplicated into
    // the live frame.
    const frame = strip(lastFrame() ?? "");
    expect(frame.split(markRow).length - 1).toBe(1);

    // No duplicate info lines under the wordmark.
    expect(frame).not.toContain("oxagen.sh cli");
    unmount();
  });
});
