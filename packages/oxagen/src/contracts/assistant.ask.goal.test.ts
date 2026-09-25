import { describe, expect, it } from "vitest";
import {
  ASSISTANT_GOAL_MAX_CHARS,
  ASSISTANT_GOAL_MAX_ROUNDS,
  assistantAsk,
  assistantGoalSchema,
} from "./assistant.ask";

describe("ask_assistant goal", () => {
  it("is optional, so a turn without one is the ordinary turn", () => {
    expect(assistantAsk.input.parse({ content: "hi" })).not.toHaveProperty(
      "goal",
    );
  });

  it("takes a statement and defaults to three rounds", () => {
    const parsed = assistantAsk.input.parse({
      content: "author the rule",
      goal: { statement: "  a query over OWNS_ACCOUNT returns a node  " },
    });
    expect(parsed.goal).toEqual({
      statement: "a query over OWNS_ACCOUNT returns a node",
      maxRounds: 3,
    });
  });

  it("stays off the agent surface, so the model cannot set its own goal", () => {
    expect(assistantAsk.surfaces).not.toContain("agent");
  });

  it("refuses a blank goal, one past the cap, too many rounds and an unknown key (negative)", () => {
    const refused = [
      { statement: "   " },
      { statement: "x".repeat(ASSISTANT_GOAL_MAX_CHARS + 1) },
      { statement: "done", maxRounds: ASSISTANT_GOAL_MAX_ROUNDS + 1 },
      { statement: "done", maxRounds: 0 },
      { statement: "done", verifierProviderId: "other" },
    ];
    for (const goal of refused) {
      expect(assistantGoalSchema.safeParse(goal).success).toBe(false);
    }
  });

  it("accepts a goal at the cap and at the round ceiling", () => {
    expect(
      assistantGoalSchema.parse({
        statement: "x".repeat(ASSISTANT_GOAL_MAX_CHARS),
        maxRounds: ASSISTANT_GOAL_MAX_ROUNDS,
      }).maxRounds,
    ).toBe(ASSISTANT_GOAL_MAX_ROUNDS);
  });
});
