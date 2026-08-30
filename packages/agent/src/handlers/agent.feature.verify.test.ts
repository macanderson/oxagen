import { describe, expect, it, vi, beforeEach } from "vitest";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const h = vi.hoisted(() => ({
  gatewayModels: [
    {
      id: "anthropic/claude-opus-4.8",
      name: "Opus",
      vendor: "anthropic",
      released: "2026",
      capabilities: ["reasoning", "vision", "tools"],
    },
    {
      id: "openai/gpt-5.2",
      name: "GPT",
      vendor: "openai",
      released: "2026",
      capabilities: ["reasoning", "vision", "tools"],
    },
    {
      id: "google/gemini-3-pro",
      name: "Gemini",
      vendor: "google",
      released: "2026",
      capabilities: ["vision", "tools"],
    },
  ],
  generateObjectFor: vi.fn(
    async (
      _args: unknown,
    ): Promise<{
      object: {
        verdict: string;
        confidence: number;
        observations: string[];
        issues: string[];
        reasoning: string;
      };
    }> => ({
      object: {
        verdict: "pass",
        confidence: 0.92,
        observations: ["dashboard renders with the new chart"],
        issues: [],
        reasoning: "The requirement is clearly met.",
      },
    }),
  ),
  selectModel: vi.fn((sel: { model?: string }) => sel.model),
  get: vi.fn(async () => ({
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
      },
    }),
    contentType: "image/png",
    sizeBytes: 3,
  })),
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: h.generateObjectFor,
  selectModel: h.selectModel,
  gatewayModels: h.gatewayModels,
}));

vi.mock("@oxagen/storage", () => ({ storage: () => ({ get: h.get }) }));

import {
  agentFeatureVerifyHandler,
  pickJudgeModelId,
} from "./agent.feature.verify";

beforeEach(() => {
  h.generateObjectFor.mockClear();
  h.selectModel.mockClear();
  h.get.mockClear();
});

describe("pickJudgeModelId — independence from the builder", () => {
  it("excludes the builder's vendor (anthropic builder → non-anthropic judge)", () => {
    expect(pickJudgeModelId("anthropic/claude-opus-4.8")).toBe(
      "openai/gpt-5.2",
    );
  });

  it("excludes openai when the builder is openai", () => {
    expect(pickJudgeModelId("openai/gpt-5.2")).toBe(
      "anthropic/claude-opus-4.8",
    );
  });

  it("defaults to excluding anthropic when the builder is unknown", () => {
    expect(pickJudgeModelId(undefined)).toBe("openai/gpt-5.2");
  });
});

describe("agent.feature.verify handler", () => {
  it("reads each screenshot, judges with a different-vendor model, returns the verdict", async () => {
    const out = await agentFeatureVerifyHandler(
      {
        requirement: "The dashboard shows a revenue chart",
        screenshotKeys: ["image/ws_1/a.png", "image/ws_1/b.png"],
        builderModel: "anthropic/claude-opus-4.8",
        checklist: ["chart is visible", "no error banner"],
      },
      CTX,
    );

    expect(out.verdict).toBe("pass");
    expect(out.confidence).toBe(0.92);
    expect(out.judgeModel).toBe("openai/gpt-5.2"); // different vendor than builder
    expect(out.builderModel).toBe("anthropic/claude-opus-4.8");
    expect(out.observations).toContain("dashboard renders with the new chart");

    // Read both screenshots.
    expect(h.get).toHaveBeenCalledTimes(2);
    // Judged with the independent model.
    expect(h.selectModel).toHaveBeenCalledWith({ model: "openai/gpt-5.2" });
    // Two image parts + one text part went to the model.
    const call = h.generateObjectFor.mock.calls[0]![0] as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    const parts = call.messages[0]!.content;
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
    expect(parts.some((p) => p.type === "text")).toBe(true);
  });

  it("passes through a fail verdict from the judge", async () => {
    h.generateObjectFor.mockResolvedValueOnce({
      object: {
        verdict: "fail",
        confidence: 0.8,
        observations: ["page shows a 500 error"],
        issues: ["no chart rendered"],
        reasoning: "The page errored.",
      },
    });

    const out = await agentFeatureVerifyHandler(
      { requirement: "shows a chart", screenshotKeys: ["image/ws_1/a.png"] },
      CTX,
    );

    expect(out.verdict).toBe("fail");
    expect(out.issues).toContain("no chart rendered");
    expect(out.builderModel).toBeNull();
    expect(out.judgeModel).toBe("openai/gpt-5.2"); // unknown builder → excludes anthropic
  });
});
