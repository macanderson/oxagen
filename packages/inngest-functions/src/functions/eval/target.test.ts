import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(),
  tierModelId: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  selectModel: mocks.selectModel,
  tierModelId: mocks.tierModelId,
}));

const { runTarget } = await import("./target");

const SELECTED_MODEL = { __marker: "selected-model" };
const TELEMETRY = {
  orgId: "org-1",
  workspaceId: "ws-1",
  surface: "runner" as const,
  messageId: null,
};

describe("runTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectModel.mockReturnValue(SELECTED_MODEL);
    mocks.tierModelId.mockReturnValue("balanced/default-model");
  });

  it("model-kind target: uses the requested modelId and returns the answer + resolved modelId", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: { answer: "Paris" },
      usage: { promptTokens: 30, completionTokens: 5 },
    });

    const result = await runTarget({
      input: "What is the capital of France?",
      systemPrompt: "You are a geography expert.",
      modelId: "anthropic/claude-haiku",
      telemetry: TELEMETRY,
    });

    expect(result).toEqual({
      output: "Paris",
      modelId: "anthropic/claude-haiku",
      usage: { promptTokens: 30, completionTokens: 5 },
    });

    expect(mocks.tierModelId).not.toHaveBeenCalled();
    expect(mocks.selectModel).toHaveBeenCalledWith({
      model: "anthropic/claude-haiku",
    });
    const call = mocks.generateObjectFor.mock.calls[0]?.[0] as {
      system: string | undefined;
      prompt: string;
      model: unknown;
      telemetry: unknown;
    };
    expect(call.system).toBe("You are a geography expert.");
    expect(call.prompt).toBe("What is the capital of France?");
    expect(call.model).toBe(SELECTED_MODEL);
    expect(call.telemetry).toEqual(TELEMETRY);
  });

  it("falls back to the balanced tier model when modelId is null", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: { answer: "42" },
      usage: { promptTokens: 10, completionTokens: 2 },
    });

    const result = await runTarget({
      input: "What is the answer to life?",
      systemPrompt: null,
      modelId: null,
      telemetry: TELEMETRY,
    });

    expect(mocks.tierModelId).toHaveBeenCalledWith("balanced");
    expect(result.modelId).toBe("balanced/default-model");
    expect(mocks.selectModel).toHaveBeenCalledWith({
      model: "balanced/default-model",
    });
    const call = mocks.generateObjectFor.mock.calls[0]?.[0] as {
      system: string | undefined;
    };
    expect(call.system).toBeUndefined();
  });

  it("agent-kind target: caller resolves the agent's instruction prompt and passes it as systemPrompt", async () => {
    // The executor resolves the agent's published instructions and passes them
    // in as `systemPrompt` — target.ts itself has no agent-specific branch, it
    // just forwards whatever systemPrompt it is given.
    mocks.generateObjectFor.mockResolvedValue({
      object: { answer: "Agent-produced answer." },
      usage: { promptTokens: 50, completionTokens: 15 },
    });

    const result = await runTarget({
      input: "Summarize the entity.",
      systemPrompt: "You are the published instructions for agent 'my-agent'.",
      modelId: null,
      telemetry: TELEMETRY,
    });

    expect(result).toEqual({
      output: "Agent-produced answer.",
      modelId: "balanced/default-model",
      usage: { promptTokens: 50, completionTokens: 15 },
    });
    const call = mocks.generateObjectFor.mock.calls[0]?.[0] as {
      system: string | undefined;
    };
    expect(call.system).toBe(
      "You are the published instructions for agent 'my-agent'.",
    );
  });
});
