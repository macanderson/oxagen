/**
 * End-to-end proof of the REPL's side-panel keyboard navigation wiring: with an
 * agent in the roster, Down moves focus off the prompt bar into the Agent Team
 * panel (a pointer glyph appears), and Ctrl-X twice on the highlighted row
 * deletes it from the roster. The turn pipeline is mocked (never invoked here);
 * we only drive keystrokes against the real <ReplApp/>.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first: ReplApp reaches beyond runTurn (e.g. model-roles.ts
  // resolves the judge via pickAdvisorModel at mount) — a bare factory
  // mock crashes the very first render with undefined exports.
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  runTurn: () => new Promise<never>(() => {}), // never resolves; no turn needed here
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
  resolveModelId: (o?: string) => o ?? "test/model",
  explicitModelId: (override?: string) => override ?? undefined,
  resolveEffort: () => undefined,
  isReasoningEffort: (s: string) =>
    ["low", "medium", "high", "xhigh", "max"].includes(s),
  EFFORT_LEVELS: ["low", "medium", "high", "xhigh", "max"] as const,
}));
vi.mock("../../agent/code-graph.js", () => ({
  queryCodeGraph: async () => "",
  warmCodeGraph: () => {},
}));

const { ReplApp } = await import("../interactive.js");
const { agentRegistry } = await import("../../agent/agent-registry.js");
const { taskRegistry } = await import("../../agent/task-registry.js");

const TEST_SESSION = {
  token: "test-token",
  orgSlug: "test-org",
  workspaceSlug: "test-ws",
  apiUrl: "http://localhost:4000",
};

const ESC = String.fromCharCode(27);
const ARROW_DOWN = `${ESC}[B`;
const ARROW_UP = `${ESC}[A`;
const CTRL_X = "\x18";
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The dock only docks on a wide-enough terminal; force one for these tests.
let savedCols: number | undefined;
beforeEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
  savedCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    value: 200,
    configurable: true,
  });
});
afterEach(() => {
  agentRegistry.clear();
  taskRegistry.clear();
  Object.defineProperty(process.stdout, "columns", {
    value: savedCols,
    configurable: true,
  });
});

describe("REPL side-panel navigation", () => {
  it("Down enters the Agent Team panel and highlights the first row", async () => {
    // A non-turn agent: in `auto` panel mode the dock is reachable only with
    // real fleet activity (hasFleetActivity deliberately excludes the turn itself).
    agentRegistry.register({
      kind: "subagent",
      title: "refactor the parser",
      id: "agent-1",
    });
    const { stdin, lastFrame, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(120); // let the async session-memory mount settle

    // No panel focus yet → the focus-only keybinding legend is absent. (The `❯`
    // glyph can't be used as the signal — the prompt bar renders it too.)
    expect(lastFrame() ?? "").not.toContain("Ctrl-E open");

    stdin.write(ARROW_DOWN);
    await tick();
    const frame = lastFrame() ?? "";
    // The dock column ellipsizes long titles ("refactor the pars…") — assert a
    // prefix that survives truncation at any reasonable dock width.
    expect(frame).toContain("refactor the par");
    // The keybinding legend appears only while a panel row holds focus.
    expect(frame).toContain("Ctrl-E open");

    // Up off the first row returns focus to the bar (legend gone).
    stdin.write(ARROW_UP);
    await tick();
    expect(lastFrame() ?? "").not.toContain("Ctrl-E open");
    unmount();
  });

  it("Ctrl-X twice on the highlighted row deletes it from the roster", async () => {
    agentRegistry.register({ kind: "turn", title: "keep me", id: "agent-1" });
    agentRegistry.register({
      kind: "subagent",
      title: "delete me",
      id: "agent-2",
    });
    const { stdin, lastFrame, unmount } = render(
      <ReplApp options={{ session: TEST_SESSION }} />,
    );
    await tick(120);

    // Down to first row, Down again to the second ("delete me").
    stdin.write(ARROW_DOWN);
    await tick();
    stdin.write(ARROW_DOWN);
    await tick();
    expect(lastFrame() ?? "").toContain("delete me");

    // First Ctrl-X arms; second within the window deletes.
    stdin.write(CTRL_X);
    await tick();
    stdin.write(CTRL_X);
    await tick();

    expect(agentRegistry.snapshot().map((a) => a.id)).toEqual(["agent-1"]);
    expect(lastFrame() ?? "").not.toContain("delete me");
    unmount();
  });
});
