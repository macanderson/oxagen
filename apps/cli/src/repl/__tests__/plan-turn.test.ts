/**
 * plan-turn.test.ts — the REPL's per-turn planner wrapper.
 *
 * Verifies the real-plan contract: the planner is called with a
 * conversation-aware goal, its tasks pass through untouched, a planner failure
 * degrades to a genuine router-derived single-task plan (never a canned
 * checklist), and a user cancel propagates instead of "planning".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";
import { isSingleTaskGoal } from "@oxagen/agent-engine";
import {
  fallbackPlan,
  historyDigest,
  planReplTurn,
  type PlanFn,
} from "../plan-turn.js";
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
  it("forwards the RAW goal plus the conversation digest as separate context", async () => {
    let seenGoal = "";
    let seenContext: string | undefined;
    const planFn: PlanFn = async (opts) => {
      seenGoal = opts.goal;
      seenContext = opts.context;
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
    // The planner receives the RAW goal (so the engine single-task fast path is
    // never defeated) and the conversation digest as SEPARATE context.
    expect(seenGoal).toBe("current ask");
    expect(seenContext).toContain("earlier ask");
  });

  it("passes the raw goal and no context when there is no history", async () => {
    let seenGoal = "";
    let seenContext: string | undefined = "sentinel";
    const planFn: PlanFn = async (opts) => {
      seenGoal = opts.goal;
      seenContext = opts.context;
      return makePlan(1) as never;
    };
    await planReplTurn({ goal: "solo ask", history: [], ai: AI_STUB, planFn });
    expect(seenGoal).toBe("solo ask");
    expect(seenContext).toBeUndefined();
  });

  it("keeps a trivial single-task goal fast-path-eligible on a history-bearing turn", async () => {
    // Regression for the defeated fast path: the digest used to be prepended to
    // the goal, making it multi-line so `isSingleTaskGoal` always returned false
    // and every follow-up paid for a planner+enhance round-trip. The goal handed
    // to the engine planner must stay the raw, single-line submission.
    let seenGoal = "";
    let seenContext: string | undefined;
    const planFn: PlanFn = async (opts) => {
      seenGoal = opts.goal;
      seenContext = opts.context;
      return makePlan(1) as never;
    };
    await planReplTurn({
      goal: "fix the typo in README",
      history: [
        { role: "user", content: "add a route" },
        { role: "assistant", content: "done, added /v1/foo" },
      ],
      ai: AI_STUB,
      planFn,
    });
    expect(seenGoal).toBe("fix the typo in README");
    // The exact predicate the engine planner uses to skip the LLM call.
    expect(isSingleTaskGoal(seenGoal)).toBe(true);
    // The history still reaches the planner — just as reference-resolution context.
    expect(seenContext).toContain("add a route");
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
    const plan = await planReplTurn({
      goal: "do a thing",
      history: [],
      ai: AI_STUB,
      planFn,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.description).toBe("do a thing");
  });

  it("degrades to the fallback when the planner exceeds the time bound", async () => {
    const planFn: PlanFn = () => new Promise(() => {}) as never; // never settles
    const plan = await planReplTurn({
      goal: "slow thing",
      history: [],
      ai: AI_STUB,
      planFn,
      timeoutMs: 30,
    });
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]!.description).toBe("slow thing");
  });

  it("keeps a planner that finishes inside the bound", async () => {
    const planFn: PlanFn = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(makePlan(2) as never), 5),
      );
    const plan = await planReplTurn({
      goal: "prompt one",
      history: [],
      ai: AI_STUB,
      planFn,
      timeoutMs: 500,
    });
    expect(plan.tasks).toHaveLength(2);
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

describe("planReplTurn — OXAGEN_PLAN_TIMEOUT_MS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** A planner that settles after `ms`, so a bound below it degrades and one above it doesn't. */
  const slowPlanner =
    (ms: number): PlanFn =>
    () =>
      new Promise((resolve) =>
        setTimeout(() => resolve(makePlan(2) as never), ms),
      );

  it("bounds the planner at the env value when no explicit timeout is passed", async () => {
    vi.stubEnv("OXAGEN_PLAN_TIMEOUT_MS", "10");
    const plan = await planReplTurn({
      goal: "slow thing",
      history: [],
      ai: AI_STUB,
      planFn: slowPlanner(200),
    });
    expect(plan.tasks).toHaveLength(1); // the routed fallback, not the 2-task plan
    expect(plan.tasks[0]!.description).toBe("slow thing");
  });

  it("lets an explicit timeoutMs override the env value", async () => {
    // The env would have cut this off at 10ms; the caller's bound wins.
    vi.stubEnv("OXAGEN_PLAN_TIMEOUT_MS", "10");
    const plan = await planReplTurn({
      goal: "slow thing",
      history: [],
      ai: AI_STUB,
      planFn: slowPlanner(30),
      timeoutMs: 2_000,
    });
    expect(plan.tasks).toHaveLength(2);
  });

  it("disables the bound entirely at 0, so a slow planner still returns its real plan", async () => {
    vi.stubEnv("OXAGEN_PLAN_TIMEOUT_MS", "0");
    const plan = await planReplTurn({
      goal: "slow thing",
      history: [],
      ai: AI_STUB,
      planFn: slowPlanner(30),
    });
    expect(plan.tasks).toHaveLength(2);
  });

  it("falls back to the built-in default when the env value is not a number", async () => {
    vi.stubEnv("OXAGEN_PLAN_TIMEOUT_MS", "soon");
    const plan = await planReplTurn({
      goal: "quick thing",
      history: [],
      ai: AI_STUB,
      planFn: slowPlanner(5),
    });
    // The default bound is 60s, so a 5ms planner is nowhere near it.
    expect(plan.tasks).toHaveLength(2);
  });
});
