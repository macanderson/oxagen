/**
 * Prompt evaluator — proves the cheap front-of-pipeline call returns the model's
 * structured read, clamps out-of-range scores, never drops intent to an empty
 * rewrite, and degrades to a deterministic heuristic when the model call fails.
 * The model call is mocked, so no gateway is touched.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));

import { generateObject } from "ai";
import { evaluatePrompt } from "../evaluator.js";

const mockGen = generateObject as unknown as Mock;

beforeEach(() => {
  delete process.env["OXAGEN_LLM_EVALUATOR"];
  delete process.env["OXAGEN_LLM_FAST"];
});

describe("evaluatePrompt", () => {
  it("returns the model's structured evaluation on the fast tier", async () => {
    mockGen.mockResolvedValueOnce({
      object: {
        completeness: 80,
        complexity: 40,
        recommendedTier: "balanced",
        missing: ["which file"],
        contextQueries: ["loginUser"],
        refinedPrompt: "fix loginUser null check",
        removed: ["please"],
        reasoning: "clear ask",
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const ev = await evaluatePrompt({ prompt: "please fix loginUser" });
    expect(ev.fallback).toBe(false);
    expect(ev.completeness).toBe(80);
    expect(ev.recommendedTier).toBe("balanced");
    expect(ev.contextQueries).toEqual(["loginUser"]);
    expect(ev.refinedPrompt).toBe("fix loginUser null check");
    expect(ev.model).toContain("haiku");
    expect(ev.usage.inputTokens).toBe(10);
  });

  it("clamps scores into 0–100 and rounds them", async () => {
    mockGen.mockResolvedValueOnce({
      object: {
        completeness: 150,
        complexity: -20,
        recommendedTier: "fast",
        missing: [],
        contextQueries: [],
        refinedPrompt: "x",
        removed: [],
        reasoning: "r",
      },
      usage: {},
    });
    const ev = await evaluatePrompt({ prompt: "do x" });
    expect(ev.completeness).toBe(100);
    expect(ev.complexity).toBe(0);
  });

  it("keeps the original prompt when the model returns an empty rewrite", async () => {
    mockGen.mockResolvedValueOnce({
      object: {
        completeness: 50,
        complexity: 50,
        recommendedTier: "fast",
        missing: [],
        contextQueries: [],
        refinedPrompt: "   ",
        removed: [],
        reasoning: "r",
      },
      usage: {},
    });
    const ev = await evaluatePrompt({ prompt: "keep me intact" });
    expect(ev.refinedPrompt).toBe("keep me intact");
  });

  it("falls back to a heuristic when the model call throws", async () => {
    mockGen.mockRejectedValueOnce(new Error("gateway down"));
    const ev = await evaluatePrompt({ prompt: "implement the stripe billing refund flow" });
    expect(ev.fallback).toBe(true);
    // A high-stakes billing prompt routes to precise → complexity 85.
    expect(ev.recommendedTier).toBe("precise");
    expect(ev.complexity).toBe(85);
    expect(ev.refinedPrompt).toBe("implement the stripe billing refund flow");
    expect(ev.usage.costUsd).toBe(0);
  });

  it("heuristic completeness tracks prompt length", async () => {
    mockGen.mockRejectedValue(new Error("down"));
    const short = await evaluatePrompt({ prompt: "fix it" });
    expect(short.completeness).toBe(45);
    const long = await evaluatePrompt({
      prompt: "a".repeat(200) + " refactor and debug the module thoroughly",
    });
    expect(long.completeness).toBe(80);
  });
});
