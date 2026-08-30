/**
 * createEngineRunner — proves the fleet's default runner maps its AgentRunner
 * contract onto the engine `runTurn` (agent persona, bare execution, model
 * resolution, return shape). Everything heavy is mocked — no model, no network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const runTurnMock = vi.fn();
vi.mock("@oxagen/agent-engine", () => ({
  runTurn: (a: unknown) => runTurnMock(a),
}));
vi.mock("../adapters/index.js", () => ({
  createCwdWorkspace: vi.fn(() => ({ root: "/repo" })),
  createCodeGraphProvider: vi.fn(() => ({})),
  createGatewayAgentAi: vi.fn(() => ({ id: "gateway" })),
}));
vi.mock("../metered-ai.js", () => ({
  createMeteredAi: vi.fn((base: unknown) => base),
}));
vi.mock("../code-graph.js", () => ({ queryCodeGraph: vi.fn() }));
vi.mock("../turn-extras.js", () => ({
  buildTurnExtras: vi.fn(async () => ({
    systemAppend: "",
    extraTools: undefined,
    wrapTools: (t: unknown) => t,
    closeMcp: vi.fn(async () => {}),
  })),
}));
vi.mock("../../settings/resolve.js", () => ({
  loadSettings: vi.fn(() => ({ settings: {} })),
}));
vi.mock("../../lib/debug-log.js", () => ({ debugLog: vi.fn() }));

import { createEngineRunner } from "../engine-runner.js";
import { buildTurnExtras } from "../turn-extras.js";

beforeEach(() => {
  runTurnMock.mockReset().mockResolvedValue({
    text: "done",
    steps: 5,
    messages: [],
    usage: { inputTokens: 100, outputTokens: 40 },
    trace: {},
  });
});

describe("createEngineRunner", () => {
  it("runs the agent persona through runTurn in bare mode and maps the result", async () => {
    const run = createEngineRunner();
    const result = await run({
      prompt: "fix the bug",
      cwd: "/repo",
      agent: {
        name: "break-fix",
        description: "fixer",
        systemPrompt: "You fix bugs.",
        source: "test",
        tools: ["read_file", "edit_file", "bash"],
        model: "anthropic/claude-fable-5",
      },
    });

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const args = runTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args["agent"]).toEqual({
      name: "break-fix",
      systemPrompt: "You fix bugs.",
    });
    expect(args["bare"]).toBe(true); // agent prompt authoritative — no pipeline
    expect(args["model"]).toBe("anthropic/claude-fable-5"); // from the agent
    expect(args["prompt"]).toBe("fix the bug");

    // Return shape matches the AgentRunner contract.
    expect(result).toEqual({
      text: "done",
      steps: 5,
      usage: { inputTokens: 100, outputTokens: 40 },
    });
  });

  it("prefers an explicit model over the agent's model", async () => {
    const run = createEngineRunner();
    await run({
      prompt: "x",
      cwd: "/repo",
      model: "openai/gpt-5",
      agent: {
        name: "a",
        description: "",
        systemPrompt: "s",
        source: "test",
        model: "anthropic/claude-fable-5",
      },
    });
    const args = runTurnMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(args["model"]).toBe("openai/gpt-5");
  });

  it("restricts the tool set to the agent allowlist via buildTurnExtras", async () => {
    const run = createEngineRunner();
    await run({
      prompt: "x",
      cwd: "/repo",
      agent: {
        name: "a",
        description: "",
        systemPrompt: "s",
        source: "test",
        tools: ["read_file"],
      },
    });
    const extrasArg = (buildTurnExtras as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![0] as Record<string, unknown>;
    expect(extrasArg["agentTools"]).toEqual(["read_file"]);
    expect(extrasArg["gatePermissions"]).toBe(true); // fleet has no broker
  });
});
