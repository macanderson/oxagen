/**
 * createPrFixRunner — proves the `oxagen pr fix` turn is assembled exactly as
 * the module docblock promises: session-routed AI (gateway-direct for the
 * synthetic benchmark session, platform otherwise) behind the meter, an
 * acceptEdits broker gating the workspace, server memory only for
 * authenticated real sessions, and one bare bounded runTurn per fixer call
 * with the inactivity runner stopped on every exit path. Everything heavy is
 * mocked — no model, no network, no filesystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";

const runTurnMock = vi.fn();
vi.mock("@oxagen/agent-engine", () => ({ runTurn: (a: unknown) => runTurnMock(a) }));

const cwdWorkspace = { id: "cwd-workspace" };
const gatedWorkspace = { id: "gated-workspace" };
const codeGraphSentinel = { id: "code-graph" };
const combinedMemory = { id: "combined-memory" };
const serverMemoryMock = { remember: vi.fn() };
const platformAi = { id: "platform-ai" };
const gatewayAi = { id: "gateway-ai" };
vi.mock("./adapters/index.js", () => ({
  createCwdWorkspace: vi.fn(() => cwdWorkspace),
  createGatedWorkspace: vi.fn(() => gatedWorkspace),
  createCombinedMemory: vi.fn(() => combinedMemory),
  createServerMemory: vi.fn(() => serverMemoryMock),
  createCodeGraphProvider: vi.fn(() => codeGraphSentinel),
  createPlatformAgentAi: vi.fn(() => platformAi),
  createGatewayAgentAi: vi.fn(() => gatewayAi),
}));

const meteredAi = { id: "metered-ai" };
vi.mock("./metered-ai.js", () => ({ createMeteredAi: vi.fn(() => meteredAi) }));
vi.mock("./code-graph.js", () => ({ queryCodeGraph: vi.fn() }));

const brokerSentinel = { id: "broker" };
vi.mock("./permissions.js", () => ({
  PermissionBroker: vi.fn(function () {
    return brokerSentinel;
  }),
}));

const permissionsSentinel = { allow: ["Edit"] };
vi.mock("../settings/resolve.js", () => ({
  loadSettings: vi.fn(() => ({ settings: { permissions: permissionsSentinel } })),
}));

vi.mock("../lib/api.js", () => ({ resolveApiContext: vi.fn() }));
vi.mock("../lib/debug-log.js", () => ({ debugLog: vi.fn() }));
vi.mock("./tool-formatter.js", () => ({
  formatToolCallWithSpacing: vi.fn((name: string) => `[tool ${name}]`),
}));

const turnRunner = {
  signal: { id: "runner-signal" } as unknown as AbortSignal,
  noteProgress: vi.fn(),
  noteToolStart: vi.fn(),
  noteToolEnd: vi.fn(),
  stop: vi.fn(),
};
vi.mock("./timeouts.js", () => ({
  createTurnRunner: vi.fn(() => turnRunner),
  resolveTurnInactivityMs: vi.fn(() => 111_000),
}));

import { createPrFixRunner } from "./pr-fix-runner.js";
import {
  createCwdWorkspace,
  createGatedWorkspace,
  createCombinedMemory,
  createServerMemory,
  createCodeGraphProvider,
  createPlatformAgentAi,
  createGatewayAgentAi,
} from "./adapters/index.js";
import { createMeteredAi } from "./metered-ai.js";
import { queryCodeGraph } from "./code-graph.js";
import { PermissionBroker } from "./permissions.js";
import { resolveApiContext } from "../lib/api.js";
import { debugLog } from "../lib/debug-log.js";
import { formatToolCallWithSpacing } from "./tool-formatter.js";
import { createTurnRunner } from "./timeouts.js";
import type { Session } from "../lib/session.js";

const asMock = (fn: unknown): Mock => fn as Mock;

const realSession: Session = {
  token: "tok-1",
  orgSlug: "acme",
  workspaceSlug: "main",
  apiUrl: "https://api.oxagen.test",
};

const syntheticSession: Session = { ...realSession, synthetic: true };

function makeRunner(over: Partial<Parameters<typeof createPrFixRunner>[0]> = {}) {
  return createPrFixRunner({
    session: realSession,
    cwd: "/work/repo",
    memoryExecutionRef: "pr-fix#7",
    ...over,
  });
}

const originalIsTty = process.stdout.isTTY;
// The generic ReturnType<typeof vi.spyOn> collapses process.stderr.write's
// overloads into an incompatible MockInstance — infer the concrete type from
// the call instead.
let stderrSpy: ReturnType<typeof spyOnStderr>;
const spyOnStderr = () =>
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);

beforeEach(() => {
  runTurnMock.mockReset().mockResolvedValue({ text: "patched" });
  asMock(resolveApiContext).mockReset().mockReturnValue(null);
  stderrSpy = spyOnStderr();
});

afterEach(() => {
  process.stdout.isTTY = originalIsTty;
  stderrSpy.mockRestore();
});

describe("createPrFixRunner wiring", () => {
  it("routes a real session through the metered platform AI", () => {
    makeRunner();
    expect(createPlatformAgentAi).toHaveBeenCalledWith({
      apiUrl: "https://api.oxagen.test",
      token: "tok-1",
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    expect(createGatewayAgentAi).not.toHaveBeenCalled();
    expect(createMeteredAi).toHaveBeenCalledTimes(1);
    const [base, meterOpts] = asMock(createMeteredAi).mock.calls[0]! as [
      unknown,
      { onLog: (line: string) => void },
    ];
    expect(base).toBe(platformAi);
    meterOpts.onLog("stalled 30s");
    expect(debugLog).toHaveBeenCalledWith("timeout", "stalled 30s");
  });

  it("routes the synthetic benchmark session gateway-direct with no server memory", () => {
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    makeRunner({ session: syntheticSession });
    expect(createGatewayAgentAi).toHaveBeenCalledWith({ cwd: "/work/repo" });
    expect(createPlatformAgentAi).not.toHaveBeenCalled();
    expect(createServerMemory).not.toHaveBeenCalled();
  });

  it("gates the cwd workspace behind an acceptEdits broker built from settings", () => {
    makeRunner();
    expect(asMock(PermissionBroker).mock.calls[0]![0]).toEqual({
      mode: "acceptEdits",
      cwd: "/work/repo",
      permissions: permissionsSentinel,
    });
    expect(createCwdWorkspace).toHaveBeenCalledWith("/work/repo");
    expect(createGatedWorkspace).toHaveBeenCalledWith(cwdWorkspace, brokerSentinel);
  });

  it("creates server memory for an authenticated real session, stamped with the execution ref and project name", () => {
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    makeRunner();
    expect(createServerMemory).toHaveBeenCalledWith({
      agentId: "pr-fix",
      executionRef: "pr-fix#7",
      projectName: "repo",
    });
  });

  it("stamps no project name when the cwd has no basename", () => {
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    makeRunner({ cwd: "/" });
    expect(asMock(createServerMemory).mock.calls[0]![0]).toMatchObject({
      projectName: undefined,
    });
  });

  it("skips server memory when not authenticated", () => {
    makeRunner();
    expect(createServerMemory).not.toHaveBeenCalled();
  });

  it("wires the code-graph provider to queryCodeGraph against this cwd", () => {
    makeRunner();
    const query = asMock(createCodeGraphProvider).mock.calls[0]![0] as (
      op: string,
      q: string,
      l: number,
    ) => unknown;
    query("callers", "runTurn", 5);
    expect(queryCodeGraph).toHaveBeenCalledWith("/work/repo", "callers", "runTurn", 5);
  });
});

describe("runFixer", () => {
  it("runs one bare, bounded, edit-capable turn and returns its text", async () => {
    process.stdout.isTTY = false;
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    const { runFixer } = makeRunner({ model: "anthropic/claude-fable-5" });

    const result = await runFixer("fix the failing lint check");

    expect(createTurnRunner).toHaveBeenCalledWith({ turnInactivityMs: 111_000 });
    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const args = runTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args["prompt"]).toBe("fix the failing lint check");
    expect(args["workspace"]).toBe(gatedWorkspace);
    expect(args["ai"]).toBe(meteredAi);
    expect(args["readOnly"]).toBe(false);
    expect(args["bare"]).toBe(true);
    expect(args["profile"]).toBe("headless");
    expect(args["model"]).toBe("anthropic/claude-fable-5");
    expect(args["maxSteps"]).toBe(40);
    expect(args["codeGraph"]).toBe(codeGraphSentinel);
    expect(args["signal"]).toBe(turnRunner.signal);
    expect(args["memory"]).toBe(combinedMemory);
    expect(createCombinedMemory).toHaveBeenCalledWith(null, null, {
      server: serverMemoryMock,
      recallQuery: "fix the failing lint check",
    });
    expect(result).toEqual({ text: "patched" });
    expect(turnRunner.stop).toHaveBeenCalledTimes(1);
  });

  it("passes no profile on a TTY and no model when unset", async () => {
    process.stdout.isTTY = true;
    const { runFixer } = makeRunner();
    await runFixer("p");
    const args = runTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args["profile"]).toBeUndefined();
    expect(args["model"]).toBeUndefined();
    expect(asMock(createCombinedMemory).mock.calls[0]![2]).toEqual({
      server: null,
      recallQuery: "p",
    });
  });

  it("feeds every callback into the inactivity runner and mirrors tool calls to stderr", async () => {
    const { runFixer } = makeRunner();
    runTurnMock.mockImplementation(
      async (o: {
        onText: () => void;
        onToolCall: (name: string, input: unknown) => void;
        onToolEvent: () => void;
      }) => {
        o.onText();
        o.onToolCall("edit_file", { path: "a.ts" });
        o.onToolEvent();
        return { text: "done" };
      },
    );

    await runFixer("p");

    expect(formatToolCallWithSpacing).toHaveBeenCalledWith("edit_file", { path: "a.ts" });
    expect(stderrSpy).toHaveBeenCalledWith("[tool edit_file]");
    expect(turnRunner.noteToolStart).toHaveBeenCalledTimes(1);
    expect(turnRunner.noteToolEnd).toHaveBeenCalledTimes(1);
    expect(turnRunner.noteProgress).toHaveBeenCalledTimes(3);
  });

  it("stops the runner even when the turn throws", async () => {
    const { runFixer } = makeRunner();
    runTurnMock.mockRejectedValue(new Error("model unreachable"));
    await expect(runFixer("p")).rejects.toThrow("model unreachable");
    expect(turnRunner.stop).toHaveBeenCalledTimes(1);
  });
});

describe("rememberOutcome", () => {
  it("mirrors a non-empty lesson to server memory", () => {
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    const { rememberOutcome } = makeRunner();
    const detail = { lesson: "re-run CI, never trust the model's test run", files: ["a.ts"] };
    rememberOutcome("ci-green", detail);
    expect(serverMemoryMock.remember).toHaveBeenCalledTimes(1);
    expect(serverMemoryMock.remember).toHaveBeenCalledWith("ci-green", detail);
  });

  it("drops a blank lesson", () => {
    asMock(resolveApiContext).mockReturnValue({ token: "tok" });
    const { rememberOutcome } = makeRunner();
    rememberOutcome("ci-green", { lesson: "   ", files: [] });
    expect(serverMemoryMock.remember).not.toHaveBeenCalled();
  });

  it("is a safe no-op when there is no server memory", () => {
    const { rememberOutcome } = makeRunner();
    expect(() => rememberOutcome("ci-red", { lesson: "l", files: [] })).not.toThrow();
    expect(serverMemoryMock.remember).not.toHaveBeenCalled();
  });
});
