import { describe, expect, it } from "vitest";
import { estimateTokens, wordsOf } from "./draft-text";

describe("draft text", () => {
  it("normalizes words without pulling skill parsing into other wizards", () => {
    expect(wordsOf("The release notes, for our agents")).toEqual([
      "release",
      "notes",
      "agents",
    ]);
  });
  it("rounds the shared character estimate up", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});
