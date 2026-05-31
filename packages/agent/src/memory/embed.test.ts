import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  embedSpy: vi.fn(),
  embeddingSpy: vi.fn(),
  createOpenAISpy: vi.fn(),
}));

mocks.embedSpy.mockImplementation(async () => ({
  embedding: new Array(1536).fill(0).map((_, i) => i / 1536),
}));
mocks.embeddingSpy.mockImplementation((model: string) => ({ _model: model }));
mocks.createOpenAISpy.mockImplementation(() => ({ embedding: mocks.embeddingSpy }));

vi.mock("ai", () => ({ embed: mocks.embedSpy }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mocks.createOpenAISpy }));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({ OPENAI_API_KEY: "sk-test" }),
}));

import { embedText } from "./embed.js";

describe("embedText", () => {
  beforeEach(() => {
    mocks.embedSpy.mockClear();
    mocks.embeddingSpy.mockClear();
  });

  it("uses text-embedding-3-small and returns a 1536-length vector", async () => {
    const v = await embedText("hello world");
    expect(v).toHaveLength(1536);
    expect(mocks.embeddingSpy).toHaveBeenCalledWith("text-embedding-3-small");
    expect(mocks.embedSpy).toHaveBeenCalledTimes(1);
    const args = mocks.embedSpy.mock.calls[0]?.[0] as { value: string };
    expect(args.value).toBe("hello world");
  });
});
