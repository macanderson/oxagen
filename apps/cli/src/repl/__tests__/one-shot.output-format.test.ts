/**
 * One-shot `--output-format` contract tests.
 *
 * The JSON modes are the machine interface benchmark harnesses consume, so the
 * envelope shape is load-bearing: `json` = exactly one result envelope on
 * stdout; `stream-json` = JSONL events ending with the same envelope; `text` =
 * the streamed answer. Everything heavy (engine, adapters, memory, stores) is
 * mocked — these tests exercise only the output routing in runOneShot.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Session } from "../../lib/session.js";

const runTurnMock = vi.fn();

vi.mock("@oxagen/agent-engine", () => ({
  runTurn: (args: unknown) => runTurnMock(args),
}));
vi.mock("../../agent/adapters/index.js", () => ({
  createCwdWorkspace: vi.fn(() => ({ root: "/tmp" })),
  createGatedWorkspace: vi.fn((ws: unknown) => ws),
  createCombinedMemory: vi.fn(() => ({})),
  createCodeGraphProvider: vi.fn(() => ({})),
  createPlatformAgentAi: vi.fn(() => ({})),
  createGatewayAgentAi: vi.fn(() => ({})),
}));
vi.mock("../../agent/metered-ai.js", () => ({
  createMeteredAi: vi.fn((base: unknown) => base),
}));
vi.mock("../../agent/memory.js", () => ({
  openSessionMemory: vi.fn(async () => ({ close: vi.fn() })),
}));
vi.mock("../../agent/fleet/memory.js", () => ({
  openFleetMemory: vi.fn(() => ({})),
}));
vi.mock("../../agent/trace-store.js", () => ({
  openTraceStore: vi.fn(() => null),
}));
vi.mock("../../agent/project-context.js", () => ({
  loadProjectContext: vi.fn(() => undefined),
}));
vi.mock("../../agents/loader.js", () => ({ getAgent: vi.fn() }));
vi.mock("../../agent/verbose-log.js", () => ({ appendVerboseLog: vi.fn() }));
vi.mock("../../agent/trace-format.js", () => ({
  formatVerboseSection: vi.fn(() => []),
}));
vi.mock("../../lib/config.js", () => ({ readConfig: vi.fn(() => ({})) }));
vi.mock("../../settings/resolve.js", () => ({
  loadSettings: vi.fn(() => ({ settings: { permissions: undefined } })),
}));
vi.mock("../../lib/debug-log.js", () => ({ debugLog: vi.fn() }));

import { runOneShot } from "../one-shot.js";

const session: Session = {
  token: "",
  orgSlug: "bench",
  workspaceSlug: "bench",
  apiUrl: "https://api.example",
  synthetic: true,
};

const cannedResult = {
  text: "the answer",
  steps: 3,
  messages: [],
  usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
  trace: {
    id: "turn_test_1",
    selectedModel: "anthropic/claude-opus-4-8",
    filesTouched: ["a.py"],
    commandsRun: ["pytest"],
    finalComplete: true,
    durationMs: 1234,
  },
};

let stdoutLines: string;
let stderrLines: string;
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  runTurnMock.mockReset().mockResolvedValue(cannedResult);
  stdoutLines = "";
  stderrLines = "";
  process.stdout.write = ((s: string) => {
    stdoutLines += s;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    stderrLines += s;
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  process.exitCode = undefined;
});

describe("runOneShot --output-format json", () => {
  it("emits exactly one result envelope on stdout and keeps text off stdout", async () => {
    runTurnMock.mockImplementation(
      async (args: { onText?: (d: string) => void }) => {
        args.onText?.("the ");
        args.onText?.("answer");
        return cannedResult;
      },
    );

    await runOneShot("fix it", { session, outputFormat: "json" });

    const lines = stdoutLines.trim().split("\n");
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      type: "result",
      ok: true,
      text: "the answer",
      steps: 3,
      model: "anthropic/claude-opus-4-8",
      filesTouched: ["a.py"],
      complete: true,
      traceId: "turn_test_1",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("emits an ok:false envelope and exit code 1 on error", async () => {
    runTurnMock.mockRejectedValue(new Error("gateway exploded"));

    await runOneShot("fix it", { session, outputFormat: "json" });

    const envelope = JSON.parse(stdoutLines.trim()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      type: "result",
      ok: false,
      error: "gateway exploded",
    });
    expect(process.exitCode).toBe(1);
    expect(stderrLines).toContain("gateway exploded");
  });
});

describe("runOneShot --output-format stream-json", () => {
  it("emits JSONL events for stage/text/tool and ends with the result envelope", async () => {
    runTurnMock.mockImplementation(
      async (args: {
        onStage?: (s: { label: string; detail?: string }) => void;
        onText?: (d: string) => void;
        onToolCall?: (name: string, input: unknown) => void;
        onToolEvent?: (e: {
          name: string;
          ok: boolean;
          durationMs: number;
        }) => void;
      }) => {
        args.onStage?.({ label: "executing" });
        args.onToolCall?.("bash", { command: "pytest" });
        args.onToolEvent?.({ name: "bash", ok: true, durationMs: 42 });
        args.onText?.("done");
        return cannedResult;
      },
    );

    await runOneShot("fix it", { session, outputFormat: "stream-json" });

    const events = stdoutLines
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events.map((e) => e["type"])).toEqual([
      "stage",
      "tool",
      "tool",
      "text",
      "result",
    ]);
    expect(events[1]).toMatchObject({
      type: "tool",
      phase: "start",
      name: "bash",
    });
    expect(events[2]).toMatchObject({
      type: "tool",
      phase: "end",
      name: "bash",
      ok: true,
      durationMs: 42,
    });
    expect(events[3]).toMatchObject({ type: "text", delta: "done" });
    expect(events[4]).toMatchObject({
      type: "result",
      ok: true,
      text: "the answer",
    });
  });
});

describe("runOneShot --output-format text (default)", () => {
  it("streams the answer to stdout with no JSON envelope", async () => {
    runTurnMock.mockImplementation(
      async (args: { onText?: (d: string) => void }) => {
        args.onText?.("plain answer");
        return cannedResult;
      },
    );

    await runOneShot("fix it", { session });

    expect(stdoutLines).toBe("plain answer\n");
  });
});

describe("runOneShot maxSteps threading", () => {
  it("passes maxSteps through to runTurn", async () => {
    await runOneShot("fix it", { session, outputFormat: "json", maxSteps: 42 });
    const args = runTurnMock.mock.calls[0]?.[0] as { maxSteps?: number };
    expect(args.maxSteps).toBe(42);
  });
});
