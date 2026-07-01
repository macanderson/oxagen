import { describe, it, expect } from "vitest";
import { SOURCES } from "./sources";

describe("SOURCES", () => {
  it("is non-empty", () => {
    expect(SOURCES.length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty https URL, title, and description", () => {
    for (const source of SOURCES) {
      expect(source.title.length).toBeGreaterThan(0);
      expect(source.url.startsWith("https://")).toBe(true);
      expect(source.description.length).toBeGreaterThan(0);
      expect(["paper", "leaderboard", "tool"]).toContain(source.kind);
    }
  });

  it("cites the SWE-bench paper and the Verified announcement with publication dates", () => {
    const paper = SOURCES.find((s) => s.url === "https://arxiv.org/abs/2310.06770");
    const verified = SOURCES.find((s) => s.url === "https://openai.com/index/introducing-swe-bench-verified/");
    expect(paper?.published).toBe("2023-10-10");
    expect(verified?.published).toBe("2024-08-13");
  });

  it("links to the live leaderboard rather than a hardcoded ranking", () => {
    const leaderboard = SOURCES.find((s) => s.kind === "leaderboard" && s.url === "https://www.swebench.com");
    expect(leaderboard).toBeDefined();
  });
});
