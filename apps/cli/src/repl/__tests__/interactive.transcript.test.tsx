/**
 * Regression guard for the REPL transcript rendering model.
 *
 * Two long-standing bugs shared one root cause: the REPL ran as a full-screen
 * *alternate-screen* Ink app that re-rendered the entire conversation on every
 * stream delta. Above the viewport height that (a) garbled the reasoning/tool
 * output on redraw and (b) left no terminal scrollback, so history couldn't be
 * scrolled back to. The fix drops the alternate screen and commits finalized
 * messages to Ink's <Static>, which writes each line to the terminal's real
 * scrollback exactly once (never re-diffed).
 *
 * These tests lock both halves of the fix:
 *   1. The REPL never emits the alternate-screen switch (…[?1049h/l), so the
 *      terminal's native scrollback stays live.
 *   2. Finalized assistant answers are committed to the transcript output (the
 *      Static scrollback path), i.e. they still render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

// runTurn resolves immediately with a final answer — no streaming callbacks — so
// the REPL takes the "closeStreamingBlocks → push final assistant" path and the
// answer lands as a settled (non-streaming) message that flows into <Static>.
const runTurnSpy = vi.fn<(opts: { prompt: string }) => void>();
vi.mock("@oxagen/agent-engine", () => ({
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

vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
}));

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
    if (Date.now() - start > ms) throw new Error("waitFor: condition timed out");
    await tick(10);
  }
}

describe("REPL transcript rendering (Static, no alt screen)", () => {
  beforeEach(() => {
    runTurnSpy.mockClear();
  });

  it("never switches to the alternate screen — native scrollback stays available", async () => {
    const { frames, unmount } = render(<ReplApp options={{ session: TEST_SESSION }} />);
    await tick(80);
    const all = frames.join("");
    // The alternate-screen enter/leave DECSET (…?1049h / …?1049l) must never be
    // written: it is what disabled scrollback and (over-height) garbled redraws.
    expect(all).not.toContain("1049");
    unmount();
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
    // The settled answer is written to the transcript (the <Static> scrollback
    // path) — assert it shows up in the emitted output.
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("build the thing");
    unmount();
  });

  it("renders each finalized message exactly once — no Static/live duplication", async () => {
    // Regression: a botched merge left the live region re-rendering the FULL
    // `messages` list while <Static> was ALSO committing every settled message,
    // so once a turn finished (nothing streaming) each message rendered twice.
    // The final composited frame (Static transcript + live tail) must contain the
    // settled answer EXACTLY once — it lives only in <Static>; the live tail holds
    // just the still-streaming message, which here is empty. Under the old bug it
    // appeared twice.
    const { stdin, lastFrame, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100);

    stdin.write("build the thing");
    await tick();
    stdin.write("\r");

    await waitFor(() => runTurnSpy.mock.calls.length === 1);
    // Wait until the answer has been committed to the Static transcript at least
    // once across the render history.
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    await tick(40);

    const frame = lastFrame() ?? "";
    const occurrences = frame.split("answer-to:build the thing").length - 1;
    expect(occurrences).toBe(1);
    unmount();
  });
});
