/**
 * The REPL's slash-menu → inline CLI-command execution seam.
 *
 * A CLI-sourced slash command that is fast, read-only, and dependency-free
 * (`/cost`) must run inside the REPL rather than sending the user to a shell.
 * This test drives the REAL REPL (`ReplApp`, real catalog built from the real
 * Commander tree) end to end: submits `/cost`, and asserts —
 *
 *   1. the output appears as an assistant message in the transcript, and
 *   2. NOT ONE byte reached the real `process.stdout.write` / `console.log`
 *      while Ink was mounted — the REPL is an Ink app, and anything that
 *      touches the real terminal directly (instead of going through the
 *      capture-writer seam, see lib/capture-writer.ts) corrupts its render
 *      tree. `ink-testing-library`'s `render()` already redirects Ink's OWN
 *      output through a fake stream, so any write the spy below sees can only
 *      be a stray direct call from application code, not Ink's own frames.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";

// Keep the rest of the REPL inert — same baseline mock set as the other
// interactive.*.test.tsx files (turn-errors, memory-lifecycle): a slash
// command never reaches runTurn/planning, but ReplApp's mount effects still
// touch these modules.
vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: () => null,
  parseInvocation: (input: string) => {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;
    const rest = trimmed.slice(1);
    const space = rest.search(/\s/);
    if (space === -1) return { name: rest, args: "" };
    return { name: rest.slice(0, space), args: rest.slice(space + 1).trim() };
  },
}));
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
// The REAL command tree: ReplApp no longer imports the composition root
// itself (ReplOptions.buildProgram is injected by program.tsx in production),
// so this test — which exists to drive the real catalog — injects it the
// same way.
const { buildProgram } = await import("../../program.js");

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

const tick = (ms = 15): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() - deadline > 0)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
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

describe("REPL /cost — inline CLI-command execution (no shell dead-end, no raw stdout)", () => {
  // Loosely typed on purpose: process.stdout.write is heavily overloaded, so the
  // precise MockInstance signature doesn't unify with the shared-scope let. We
  // only ever call .mockClear() and assert call-count, so the loose type is safe.
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy (don't mock away output — just observe) so a stray direct write is
    // caught as a call, not silently absorbed. ink-testing-library's render()
    // does not route Ink's frames through the real process.stdout, so any
    // call seen here is necessarily code that bypassed the capture-writer seam.
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(
        (() => true) as typeof process.stdout.write,
      ) as unknown as typeof stdoutSpy;
    consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined) as unknown as typeof consoleLogSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs /cost inline and folds its output into an assistant message", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    await submit(stdin, "/cost");
    await until(() => (lastFrame() ?? "").includes("Provide token counts"));

    const frame = lastFrame() ?? "";
    // The command header line (proves inline dispatch, not the old dead-end).
    expect(frame).toContain("oxagen cost");
    // The old misleading message must be gone.
    expect(frame).not.toContain("run it from your shell");
    expect(frame).not.toContain("This is an oxagen CLI command");
  });

  it("never calls the real process.stdout.write or console.log while running /cost", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    stdoutSpy.mockClear();
    consoleLogSpy.mockClear();

    await submit(stdin, "/cost");
    await until(() => (lastFrame() ?? "").includes("Provide token counts"));

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("runs /cost --rates inline and shows the baked-in rate card", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    await submit(stdin, "/cost --rates");
    await until(() => (lastFrame() ?? "").includes("Rate card"));

    expect(lastFrame()).toContain("anthropic");
  });
});
