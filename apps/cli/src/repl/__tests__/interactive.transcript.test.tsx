/**
 * Regression guard for the REPL transcript rendering model.
 *
 * The REPL renders the transcript as a single windowed viewport (the newest slice
 * of messages, clipped to the terminal height) — there is no <Static>/live split
 * anymore. A botched earlier model re-rendered the FULL message list in a live
 * region WHILE <Static> also committed every settled message, so once a turn
 * finished each message appeared twice.
 *
 * These tests lock the invariant that survives that history: a finalized
 * assistant answer renders in the transcript, and renders EXACTLY once (no
 * duplication). Under ink-testing-library stdout is not a TTY, so the component
 * takes its inline (non-full-screen) path — the alternate-screen takeover is
 * exercised separately in interactive.launch.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";

// runTurn resolves immediately with a final answer — no streaming callbacks — so
// the REPL takes the "closeStreamingBlocks → push final assistant" path and the
// answer lands as a settled (non-streaming) message in the transcript window.
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

describe("REPL transcript rendering (single windowed viewport)", () => {
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
    // The settled answer is rendered into the transcript viewport — assert it
    // shows up in the emitted output.
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));
    expect(runTurnSpy.mock.calls[0]?.[0].prompt).toBe("build the thing");
    unmount();
  });

  it("renders each finalized message exactly once — no duplication", async () => {
    // Regression: an earlier model re-rendered the FULL `messages` list in a live
    // region while <Static> ALSO committed every settled message, so once a turn
    // finished (nothing streaming) each message rendered twice. The single
    // windowed viewport renders each message once; the final frame must contain
    // the settled answer EXACTLY once. Under the old bug it appeared twice.
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

  it("PgUp scrolls back through history (shows the hint); PgDn returns to latest", async () => {
    // After one turn the transcript holds the user prompt + the assistant answer
    // (≥2 messages), so there is history to scroll into. PgUp raises the scroll
    // offset above 0 → the "⌃ history" hint appears; PgDn drops it back to 0 →
    // the hint clears and the app is pinned to the newest output again.
    const { stdin, lastFrame, frames, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(100);

    stdin.write("build the thing");
    await tick();
    stdin.write("\r");
    await waitFor(() => frames.join("").includes("answer-to:build the thing"));

    // PageUp — control sequence CSI 5 ~
    stdin.write("[5~");
    await waitFor(() => (lastFrame() ?? "").includes("history"));
    expect(lastFrame() ?? "").toContain("PgDn to return to the latest");

    // PageDown — control sequence CSI 6 ~ — snaps back to the newest output.
    stdin.write("[6~");
    await waitFor(() => !(lastFrame() ?? "").includes("⌃ history"));
    expect(lastFrame() ?? "").not.toContain("⌃ history");
    unmount();
  });
});
