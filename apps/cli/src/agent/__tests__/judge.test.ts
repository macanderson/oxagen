/**
 * Completeness judge — proves the advisor is always a DIFFERENT model than the
 * executor, that a model verdict is returned faithfully, that the heuristic
 * fallback flags "claimed a change but touched nothing", and that the revision
 * prompt is built from the verdict. The model call is mocked.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));

import { generateObject } from "ai";
import { judgeCompleteness, pickAdvisorModel, buildRevisionPrompt } from "../judge.js";
import type { JudgeVerdict } from "../trace.js";

const mockGen = generateObject as unknown as Mock;

beforeEach(() => {
  delete process.env["OXAGEN_LLM_ADVISOR"];
  delete process.env["OXAGEN_LLM_FAST"];
  delete process.env["OXAGEN_LLM_BALANCED"];
  delete process.env["OXAGEN_LLM_PRECISE"];
});

const baseJudge = {
  request: "add a route",
  response: "Done, added the route.",
  filesTouched: ["src/route.ts"],
  commandsRun: [],
  steps: 3,
};

describe("pickAdvisorModel", () => {
  it("defaults to the precise tier when the executor is not precise", () => {
    expect(pickAdvisorModel("anthropic/claude-sonnet-4.6")).toContain("opus");
  });

  it("falls back to a distinct tier when the executor is already precise", () => {
    const advisor = pickAdvisorModel("anthropic/claude-opus-4.8");
    expect(advisor).not.toBe("anthropic/claude-opus-4.8");
    expect(advisor).toContain("sonnet");
  });

  it("honours an explicit override that differs from the executor", () => {
    process.env["OXAGEN_LLM_ADVISOR"] = "openai/gpt-5";
    expect(pickAdvisorModel("anthropic/claude-sonnet-4.6")).toBe("openai/gpt-5");
  });

  it("ignores an override equal to the executor (must stay distinct)", () => {
    process.env["OXAGEN_LLM_ADVISOR"] = "anthropic/claude-sonnet-4.6";
    const advisor = pickAdvisorModel("anthropic/claude-sonnet-4.6");
    expect(advisor).not.toBe("anthropic/claude-sonnet-4.6");
  });
});

describe("judgeCompleteness", () => {
  it("returns the advisor's verdict, judged by a different model", async () => {
    mockGen.mockResolvedValueOnce({
      object: {
        complete: false,
        confidence: 90,
        findings: ["no test added"],
        remainingWork: ["add a test"],
        reasoning: "tests were promised but absent",
      },
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    const v = await judgeCompleteness({ ...baseJudge, executorModel: "anthropic/claude-sonnet-4.6" });
    expect(v.complete).toBe(false);
    expect(v.findings).toEqual(["no test added"]);
    expect(v.model).not.toBe("anthropic/claude-sonnet-4.6");
    expect(v.fallback).toBe(false);
    expect(v.usage.inputTokens).toBe(4);
  });

  it("clamps confidence into range", async () => {
    mockGen.mockResolvedValueOnce({
      object: { complete: true, confidence: 200, findings: [], remainingWork: [], reasoning: "ok" },
      usage: {},
    });
    const v = await judgeCompleteness({ ...baseJudge, executorModel: "anthropic/claude-haiku-4.5" });
    expect(v.confidence).toBe(100);
  });

  it("heuristic flags claimed-change-with-no-activity when the advisor is unavailable", async () => {
    mockGen.mockRejectedValueOnce(new Error("down"));
    const v = await judgeCompleteness({
      request: "add a route",
      response: "I added the route and updated the tests.",
      filesTouched: [],
      commandsRun: [],
      steps: 1,
      executorModel: "anthropic/claude-sonnet-4.6",
    });
    expect(v.fallback).toBe(true);
    expect(v.complete).toBe(false);
    expect(v.findings.length).toBeGreaterThan(0);
  });

  it("heuristic abstains to low-confidence complete when there is no red flag", async () => {
    mockGen.mockRejectedValueOnce(new Error("down"));
    const v = await judgeCompleteness({
      request: "explain how auth works",
      response: "Auth uses sessions stored in Postgres.",
      filesTouched: [],
      commandsRun: [],
      steps: 1,
      executorModel: "anthropic/claude-sonnet-4.6",
    });
    expect(v.fallback).toBe(true);
    expect(v.complete).toBe(true);
    expect(v.confidence).toBe(30);
  });
});

describe("buildRevisionPrompt", () => {
  it("renders findings and remaining work into actionable instructions", () => {
    const verdict: JudgeVerdict = {
      complete: false,
      confidence: 80,
      findings: ["missing migration"],
      remainingWork: ["write the migration"],
      reasoning: "r",
      model: "anthropic/claude-opus-4.8",
      fallback: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    const p = buildRevisionPrompt(verdict);
    expect(p).toContain("NOT done");
    expect(p).toContain("missing migration");
    expect(p).toContain("write the migration");
  });

  it("omits empty sections cleanly", () => {
    const verdict: JudgeVerdict = {
      complete: false,
      confidence: 50,
      findings: [],
      remainingWork: [],
      reasoning: "",
      model: "m",
      fallback: false,
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
    const p = buildRevisionPrompt(verdict);
    expect(p).not.toContain("Gaps found:");
    expect(p).not.toContain("Remaining work:");
    expect(p).toContain("Make the actual changes now");
  });
});
