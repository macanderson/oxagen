import { describe, expect, it } from "vitest";
import {
  DISTILL_DATASET_SLUG,
  distillEvalItem,
  distilledEvalItemSchema,
} from "./distill.js";

describe("distillEvalItem", () => {
  it("produces a valid evals-v1 item from a failed run", () => {
    const item = distillEvalItem({
      sid: "s-1",
      prompt: "refactor the auth module",
      reason: "failed",
      fate: "failed",
      model: "balanced",
      turns: 3,
      errorMessage: "turn timed out",
      failedTurn: 2,
      changedFiles: ["src/auth.ts"],
      cliVersion: "1.2.3",
      gitHead: "a".repeat(40),
      distilledAt: 1720000000000,
    });
    expect(distilledEvalItemSchema.parse(item)).toEqual(item);
    expect(item.input).toBe("refactor the auth module");
    expect(item.metadata).toMatchObject({
      source: "fleet_replay",
      sid: "s-1",
      reason: "failed",
      fate: "failed",
      error: "turn timed out",
      failedTurn: 2,
      changedFiles: ["src/auth.ts"],
      cliVersion: "1.2.3",
    });
  });

  it("keeps thumbs-down feedback comments as metadata", () => {
    const item = distillEvalItem({
      sid: "s-2",
      prompt: "write the report",
      reason: "thumbs_down",
      turns: 1,
      feedbackComment: "it fabricated numbers",
      distilledAt: 1720000000001,
    });
    expect(item.metadata["feedback"]).toBe("it fabricated numbers");
    expect(item.metadata["reason"]).toBe("thumbs_down");
    // Optional fields omitted, never null-padded.
    expect("model" in item.metadata).toBe(false);
    expect("changedFiles" in item.metadata).toBe(false);
  });

  it("refuses an empty prompt", () => {
    expect(() =>
      distillEvalItem({
        sid: "s-3",
        prompt: "  ",
        reason: "manual",
        turns: 0,
        distilledAt: 1,
      }),
    ).toThrow(/empty prompt/);
  });

  it("pins the default dataset slug", () => {
    expect(DISTILL_DATASET_SLUG).toBe("fleet-distilled-failures");
  });
});
