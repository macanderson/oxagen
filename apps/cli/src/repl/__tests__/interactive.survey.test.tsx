/**
 * ask_user survey wiring in the interactive REPL.
 *
 * The engine side (tool registration, validation, prompt rule) and the
 * SurveyPrompt component each have their own tests; THIS file pins the REPL
 * wiring: runTurn's `askUser` callback parks a promise in REPL state, the
 * SurveyPrompt overlay takes over the input row, and the user's choice
 * resolves the engine's promise exactly once, clearing the overlay.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import type { AskUserResponse } from "@oxagen/agent-engine";

let lastAnswer: AskUserResponse | null = null;

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  runTurn: async (opts: {
    prompt: string;
    askUser?: (q: {
      question: string;
      options: string[];
    }) => Promise<AskUserResponse>;
  }) => {
    // Simulate the engine deciding requirements are ambiguous mid-turn.
    if (!opts.askUser) throw new Error("askUser was not wired into runTurn");
    lastAnswer = await opts.askUser({
      question: "Which database should the service use?",
      options: ["Postgres", "SQLite"],
    });
    return {
      text: `done:${lastAnswer.answer}`,
      messages: [],
      usage: {},
      trace: { id: "trace_survey" },
    };
  },
}));

vi.mock("../../agent/model.js", () => ({
  resolveModelId: (override?: string) => override ?? "test/default-model",
  explicitModelId: (override?: string) => override ?? undefined,
  resolveEffort: () => undefined,
  isReasoningEffort: (s: string) =>
    ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));
vi.mock("../../slash/expand.js", () => ({
  loadAndExpand: () => null,
  parseInvocation: () => null,
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
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  warmCodeGraph: () => {},
}));

// Planning fires a REAL structured-output LLM call (and the memory recall
// before it) on every turn — a unit test must never drive that. Degrade to
// the same synchronous fallback plan a planner failure produces, which keeps
// the single-task -> runTurn flow this test asserts on.
vi.mock("../plan-turn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plan-turn.js")>();
  return {
    ...actual,
    planReplTurn: async ({ goal }: { goal: string }) =>
      actual.fallbackPlan(goal),
  };
});

const { ReplApp } = await import("../interactive.js");
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
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() - deadline > 0)
      throw new Error("until(): condition not met before deadline");
    await tick(stepMs);
  }
}

describe("REPL ask_user survey wiring", () => {
  beforeEach(() => {
    lastAnswer = null;
  });

  it("renders the survey overlay, resolves the engine promise with the choice, and clears", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    stdin.write("build the service");
    await tick();
    stdin.write("\r");

    // The engine asked mid-turn — the overlay takes over the input row.
    await until(() => (lastFrame() ?? "").includes("Which database"));
    expect(lastFrame()).toContain("Postgres");
    expect(lastFrame()).toContain("SQLite");

    // Enter selects the highlighted first option. The overlay paints one
    // commit BEFORE its useInput subscribes (Ink writes frames at commit;
    // useInput attaches in a passive effect), so a single keypress fired the
    // instant the question becomes visible can land in that gap and be
    // dropped — ink-testing-library's stdin does not buffer. Re-press each
    // poll until the resolver fires, like a real user would; at most one
    // press lands because pressing stops the moment lastAnswer is set, and
    // until()'s deadline still bounds the whole wait.
    await until(() => {
      if (lastAnswer === null) stdin.write("\r");
      return lastAnswer !== null;
    });
    expect(lastAnswer).toEqual({ answer: "Postgres", wasFreeText: false });

    // Overlay cleared; the turn completed with the answer folded in.
    await until(() => !(lastFrame() ?? "").includes("Which database"));
  });
});
