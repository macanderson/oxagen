import { describe, it, expect } from "vitest";
import { estimateInputTokens, estimateTokens } from "../tokens.js";

describe("token estimation", () => {
  it("approximates ~4 characters per token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("sums input tokens across all messages", () => {
    const tokens = estimateInputTokens({
      messages: [
        { role: "system", content: "abcd" },
        { role: "user", content: "abcd" },
      ],
    });
    expect(tokens).toBe(2);
  });
});
