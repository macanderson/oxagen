import { describe, expect, it } from "vitest";
import {
  evalDatasetItemSchema,
  evalJudgeScoreSchema,
  evalRunStatusSchema,
  evalTargetSchema,
} from "./eval-schema";

describe("evalTargetSchema", () => {
  it("parses a full model target", () => {
    const parsed = evalTargetSchema.parse({
      kind: "model",
      model: "anthropic/claude-sonnet-5",
      systemPrompt: "You are a helpful support agent.",
    });
    expect(parsed).toEqual({
      kind: "model",
      model: "anthropic/claude-sonnet-5",
      systemPrompt: "You are a helpful support agent.",
    });
  });

  it("parses a minimal model target with model/systemPrompt omitted", () => {
    const parsed = evalTargetSchema.parse({ kind: "model" });
    expect(parsed).toEqual({ kind: "model" });
  });

  it("parses an agent target", () => {
    const parsed = evalTargetSchema.parse({
      kind: "agent",
      agentSlug: "my-agent",
    });
    expect(parsed).toEqual({ kind: "agent", agentSlug: "my-agent" });
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      evalTargetSchema.parse({ kind: "workflow", workflowSlug: "x" }),
    ).toThrow();
  });
});

describe("evalJudgeScoreSchema", () => {
  it("parses a valid score object", () => {
    const parsed = evalJudgeScoreSchema.parse({
      correctness: 0.8,
      faithfulness: 0.75,
      score: 0.78,
      rationale: "Grounded and mostly correct.",
    });
    expect(parsed.score).toBe(0.78);
  });

  it("rejects a score over the max of 1", () => {
    expect(() =>
      evalJudgeScoreSchema.parse({
        correctness: 0.8,
        faithfulness: 0.75,
        score: 1.5,
        rationale: "x",
      }),
    ).toThrow();
  });

  it("rejects a correctness under the min of 0", () => {
    expect(() =>
      evalJudgeScoreSchema.parse({
        correctness: -0.1,
        faithfulness: 0.75,
        score: 0.5,
        rationale: "x",
      }),
    ).toThrow();
  });
});

describe("evalDatasetItemSchema", () => {
  it("parses an item with only input and defaults metadata to {}", () => {
    const parsed = evalDatasetItemSchema.parse({ input: "hello" });
    expect(parsed.input).toBe("hello");
    expect(parsed.metadata).toEqual({});
    expect(parsed.expectedOutput).toBeUndefined();
  });

  it("rejects an empty input string", () => {
    expect(() => evalDatasetItemSchema.parse({ input: "" })).toThrow();
  });
});

describe("evalRunStatusSchema", () => {
  it("accepts every documented lifecycle value", () => {
    for (const status of [
      "pending",
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
    ]) {
      expect(evalRunStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects an undocumented status value", () => {
    expect(() => evalRunStatusSchema.parse("errored")).toThrow();
  });
});
