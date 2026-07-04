/**
 * plan-turn.test.ts — the REPL's per-turn planner wrapper.
 *
 * Verifies the real-plan contract: the planner is called with a
 * conversation-aware goal, its tasks pass through untouched, a planner failure
 * degrades to a genuine router-derived single-task plan (never a canned
 * checklist), and a user cancel propagates instead of "planning".
 */
import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { fallbackPlan, historyDigest, planReplTurn, type PlanFn } from "../plan-turn.js";
import type { Plan } from "../../agent/fleet/types.js";
import { emptyUsage } from "../../agent/fleet/types.js";

const AI_STUB = {} as never;

function makePlan(taskCount: number): Plan {
  return {
    id: "plan_test",
    goal: "goal",
    createdAt: 1,
    status: "draft",
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      id: `t${i + 1}`,
      title: `Task ${i + 1}`,
      description: `Do task ${i + 1}`,
      status: "queued" as const,
      dependsOn: [],
      files: [],
      tier: "fast" as const,
      model: "m",
      createdAt: 1,
      usage: emptyUsage(),
    })),
  };
}

describe("historyDigest", () => {
  it("keeps only user/assistant text, newest last, role-prefixed", () => {
    const history: ModelMessage[] = [
      { role: "user", content: "add a route" },
      { role: "assistant", content: "done, added /v1/foo" },
      { role: "tool", content: [] } as unknown as ModelMessage,
    ];
    const digest = historyDigest(history);
    expect(digest).toContain("user: add a route");
    expect(digest).toContain("assistant: done, added /v1/foo");
    expect(digest).not.toContain("tool");
  });

  it("extracts text from parts-array content", () => {
    const history: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "part text" }],
      } as unknown as ModelMessage,
    ];
    expect(historyDigest(history)).toContain("assistant: part text");
  });

  it("is empty for empty history", () => {
    expect(historyDigest([])).toBe("");
  });
});

describe("fallbackPlan", () => {
  it("builds a single routed task straight from the goal", () => {
    const plan = fallbackPlan("fix the login bug");
    expect(plan.tasks).toHaveLength(1);
    const task = plan.tasks[0]!;
    expect(task.title).toBe("fix the login bug");
    expect(task.description).toBe("fix the login bug");
    expect(task.status).toBe("queued");
    expect(task.model).toBeTruthy();
    expect(task.tier).toBeTruthy();
  });

  it("truncates long goals in the title but not the description", () => {
    const goal = "x".repeat(100);
    const plan = fallbackPlan(goal);
    expect(plan.tasks[0]!.title.length).toBeLessThanOrEqual(64);
    expect(plan.tasks[0]!.description).toBe(goal);
  });
});

describe("planReplTurn", () => {
  it("returns the planner's tasks and rehomes the goal onto the raw submission", async () => {
    let seenGoal = "";
    const planFn: PlanFn = async (opts) => {
      seenGoal = opts.goal;
      return makePlan(3) as never;
    };
    const plan = await planReplTurn({
      goal: "current ask",
      history: [{ role: "user", content: "earlier ask" }],
      ai: AI_STUB,
      planFn,
    });
    expect(plan.tasks).toHaveLength(3);
    expect(plan.goal).toBe("current ask");
    // The planner saw the conversation digest AND the current request.
    expect(seenGoal).toContain("earlier ask");
    expect(seenGoal).toContain("current ask");
  });

  it("passes the raw goal when there is no history", async () => {
    let seenGoal = "";
    const planFn: PlanFn = async (opts) => {
      seenGoal = opts.goal;
      return makePlan(1) as never;
    };
    await planReplTurn({ goal: "solo ask", history: [], ai: AI_STUB, planFn });
    expect(seenGoal).toBe("solo ask");
  });

  it("hands the agent roster through to the planner", async () => {
    let seenAgents: unknown[] = [];
    const planFn: PlanFn = async (opts) => {
      seenAgents = opts.agents ?? [];
      return makePlan(1) as never;
    };
    await planReplTurn({
      goal: "g",
      history: [],
      ai: AI_STUB,
      planFn,
      agents: [
        {
          name: "reviewer",
          description: "reviews code",
          systemPrompt: "you review",
          source: "test",
        },
      ],
    });
    expect(seenAgents).toHaveLength(1);
    expect((seenAgents[0] as { name: string }).name).toBe("reviewer");
  });

  it("degrades to the routed single-task fallback when the planner throws", async () => {
    const planFn: PlanFn = async () => {
      throw new Error("gateway down");
    };
    const plan = await planReplTurn({ goal: "do a thing", history: [], ai: AI_STUB, planFn });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.description).toBe("do a thing");
  });

  it("re-throws when the signal is aborted (user cancel is not a fallback)", async () => {
    const controller = new AbortController();
    const planFn: PlanFn = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    await expect(
      planReplTurn({
        goal: "g",
        history: [],
        ai: AI_STUB,
        planFn,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });
});
