import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
  selectModel: mocks.selectModel,
}));

const { scoreWithJudge } = await import("./judge");

const SELECTED_MODEL = { __marker: "selected-model" };
const TELEMETRY = {
  orgId: "org-1",
  workspaceId: "ws-1",
  surface: "runner" as const,
  messageId: null,
};

describe("scoreWithJudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectModel.mockReturnValue(SELECTED_MODEL);
  });

  it("returns the judge score and usage produced by generateObjectFor", async () => {
    const judgeScore = {
      correctness: 0.8,
      faithfulness: 1,
      score: 0.75,
      rationale: "Mostly right, minor omission.",
    };
    mocks.generateObjectFor.mockResolvedValue({
      object: judgeScore,
      usage: { promptTokens: 120, completionTokens: 40 },
    });

    const result = await scoreWithJudge({
      input: "What is the capital of France?",
      expectedOutput: "Paris",
      output: "The capital of France is Paris.",
      judgeModelId: "anthropic/claude-sonnet",
      telemetry: TELEMETRY,
    });

    expect(result).toEqual({
      score: judgeScore,
      usage: { promptTokens: 120, completionTokens: 40 },
    });
  });

  it("calls generateObjectFor with the rubric system prompt and the item's input/expected/actual answer", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        correctness: 1,
        faithfulness: 1,
        score: 1,
        rationale: "Perfect.",
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    await scoreWithJudge({
      input: "What is 2+2?",
      expectedOutput: "4",
      output: "4",
      judgeModelId: "anthropic/claude-sonnet",
      telemetry: TELEMETRY,
    });

    expect(mocks.generateObjectFor).toHaveBeenCalledTimes(1);
    const call = mocks.generateObjectFor.mock.calls[0]?.[0] as {
      schema: unknown;
      system: string;
      messages: { role: string; content: string }[];
      model: unknown;
      telemetry: unknown;
    };

    // System prompt describes the judge rubric.
    expect(call.system).toContain("impartial evaluation judge");
    expect(call.system).toContain("correctness");
    expect(call.system).toContain("faithfulness");

    // Messages array contains the item's input, expected output, and the
    // actual answer under evaluation.
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]?.role).toBe("user");
    const content = call.messages[0]?.content as unknown as string;
    expect(content).toContain("What is 2+2?");
    expect(content).toContain("4");

    // Resolves the model via selectModel(judgeModelId) and forwards telemetry.
    expect(mocks.selectModel).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet",
    });
    expect(call.model).toBe(SELECTED_MODEL);
    expect(call.telemetry).toEqual(TELEMETRY);
  });

  it("tells the judge to score on soundness when no expected answer is provided", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        correctness: 0.5,
        faithfulness: 1,
        score: 0.5,
        rationale: "Plausible.",
      },
      usage: { promptTokens: 10, completionTokens: 5 },
    });

    await scoreWithJudge({
      input: "Explain photosynthesis.",
      expectedOutput: null,
      output: "Plants convert light into energy.",
      judgeModelId: "anthropic/claude-sonnet",
      telemetry: TELEMETRY,
    });

    const call = mocks.generateObjectFor.mock.calls[0]?.[0] as {
      messages: { content: string }[];
    };
    const content = call.messages[0]?.content as unknown as string;
    expect(content).toContain("(none provided");
    expect(content).not.toContain("EXPECTED ANSWER:\nnull");
  });
});
