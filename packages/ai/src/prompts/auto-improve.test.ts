import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(),
}));

vi.mock("../generate-object", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));
vi.mock("../models", () => ({ selectModel: mocks.selectModel }));

import { enhancePromptIfInsufficient } from "./auto-improve";

const TEL = {
  orgId: "o",
  workspaceId: "w",
  surface: "api" as const,
  messageId: "m",
};

beforeEach(() => {
  mocks.generateObjectFor.mockReset();
  mocks.selectModel.mockReturnValue("fast-model");
});

describe("enhancePromptIfInsufficient", () => {
  it("is a no-op when autoImprove is off (judge never runs)", async () => {
    const out = await enhancePromptIfInsufficient({
      prompt: "draw a cat",
      kind: "image",
      autoImprove: false,
      telemetry: TEL,
    });
    expect(out).toEqual({ prompt: "draw a cat", enhanced: false });
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty prompt", async () => {
    const out = await enhancePromptIfInsufficient({
      prompt: "   ",
      kind: "image",
      autoImprove: true,
      telemetry: TEL,
    });
    expect(out.enhanced).toBe(false);
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
  });

  it("returns the original when the judge deems it sufficient", async () => {
    mocks.generateObjectFor.mockResolvedValue({ object: { sufficient: true } });
    const out = await enhancePromptIfInsufficient({
      prompt: "a detailed watercolor of a red fox in autumn woods, soft light",
      kind: "image",
      autoImprove: true,
      telemetry: TEL,
    });
    expect(out).toEqual({
      prompt: "a detailed watercolor of a red fox in autumn woods, soft light",
      enhanced: false,
    });
  });

  it("returns the enhanced prompt when the judge deems it insufficient", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: {
        sufficient: false,
        enhancedPrompt: "a fox, watercolor, autumn, soft morning light",
      },
    });
    const out = await enhancePromptIfInsufficient({
      prompt: "fox",
      kind: "image",
      autoImprove: true,
      telemetry: TEL,
    });
    expect(out).toEqual({
      prompt: "a fox, watercolor, autumn, soft morning light",
      enhanced: true,
    });
  });

  it("falls back to the original when insufficient but no enhancedPrompt returned", async () => {
    mocks.generateObjectFor.mockResolvedValue({
      object: { sufficient: false },
    });
    const out = await enhancePromptIfInsufficient({
      prompt: "fox",
      kind: "image",
      autoImprove: true,
      telemetry: TEL,
    });
    expect(out).toEqual({ prompt: "fox", enhanced: false });
  });

  it("never throws — a judge error degrades to the original prompt", async () => {
    mocks.generateObjectFor.mockRejectedValue(new Error("judge down"));
    const out = await enhancePromptIfInsufficient({
      prompt: "fox",
      kind: "image",
      autoImprove: true,
      telemetry: TEL,
    });
    expect(out).toEqual({ prompt: "fox", enhanced: false });
  });
});
