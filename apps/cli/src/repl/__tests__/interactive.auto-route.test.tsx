/**
 * Worker-model auto-routing in the interactive REPL.
 *
 * The REPL used to collapse "the user chose nothing" into a pinned default
 * slug at mount, so the engine's per-turn router (cheapest sufficient tier +
 * the precise safety floor for high-stakes work) never ran for REPL turns.
 * These tests pin the new contract:
 *
 *   1. no explicit choice  → runTurn receives model: undefined (engine routes)
 *   2. /worker-model <slug> → runTurn receives the pinned slug verbatim
 *   3. /worker-model auto   → back to undefined (session-only unpin)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runTurnSpy = vi.fn<(opts: { prompt: string; model?: string }) => void>();

vi.mock("@oxagen/agent-engine", async (importOriginal) => ({
  // Real module first — a bare factory mock drops exports ReplApp's mount
  // needs (model-roles resolves the judge via pickAdvisorModel at mount).
  ...(await importOriginal<typeof import("@oxagen/agent-engine")>()),
  runTurn: (opts: { prompt: string; model?: string }) => {
    runTurnSpy(opts);
    return Promise.resolve({
      text: `done:${opts.prompt}`,
      messages: [],
      usage: {},
      trace: { id: `trace_${opts.prompt}` },
    });
  },
}));

// Deterministic model resolution: no env/config leakage from the host machine.
// explicitModelId mirrors the real contract (override or nothing); the REPL's
// auto state comes from it returning undefined.
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

async function submit(
  stdin: { write: (s: string) => void },
  text: string,
): Promise<void> {
  stdin.write(text);
  await tick();
  stdin.write("\r");
  await tick();
}

describe("REPL worker-model auto-routing", () => {
  let workDir: string;
  let realCwd: string;

  beforeEach(async () => {
    realCwd = process.cwd();
    // /worker-model persists via the settings writer — run in a temp cwd so
    // the test never touches the real repo's .oxagen/settings.local.json.
    workDir = await mkdtemp(join(tmpdir(), "oxagen-autoroute-"));
    process.chdir(workDir);
    runTurnSpy.mockClear();
  });

  afterEach(async () => {
    process.chdir(realCwd);
    await rm(workDir, { recursive: true, force: true });
  });

  it("passes model: undefined when the user chose nothing (engine routes per turn)", async () => {
    const { stdin } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    await submit(stdin, "fix the login bug");
    await until(() => runTurnSpy.mock.calls.length > 0);

    expect(runTurnSpy.mock.calls[0]?.[0]?.model).toBeUndefined();
  });

  it("passes an explicit pin verbatim, and /worker-model auto unpins again", async () => {
    const { stdin, lastFrame } = render(
      <ReplApp options={{ session: TEST_SESSION, buildProgram }} />,
    );
    await tick();

    await submit(stdin, "/worker-model zai/glm-5.2");
    await until(() => (lastFrame() ?? "").includes("model set to zai/glm-5.2"));
    await submit(stdin, "fix the login bug");
    await until(() => runTurnSpy.mock.calls.length > 0);
    expect(runTurnSpy.mock.calls[0]?.[0]?.model).toBe("zai/glm-5.2");

    await submit(stdin, "/worker-model auto");
    await until(() => (lastFrame() ?? "").includes("auto"));
    await submit(stdin, "fix the second bug");
    await until(() => runTurnSpy.mock.calls.length > 1);
    expect(runTurnSpy.mock.calls[1]?.[0]?.model).toBeUndefined();
  });

  it("honors an explicit --model option as a pin", async () => {
    const { stdin } = render(
      <ReplApp
        options={{
          session: TEST_SESSION,
          buildProgram,
          model: "anthropic/claude-fable-5",
        }}
      />,
    );
    await tick();

    await submit(stdin, "fix the login bug");
    await until(() => runTurnSpy.mock.calls.length > 0);
    expect(runTurnSpy.mock.calls[0]?.[0]?.model).toBe(
      "anthropic/claude-fable-5",
    );
  });
});
