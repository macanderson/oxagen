/**
 * Task planner — decomposes a goal into a dependency-ordered {@link Plan}.
 *
 * The AI port is faked (`generateObject` returns a fixed task list), so these
 * tests exercise the planner's own logic: id uniqueness/backfill, tier
 * reconciliation against the cost router's safety floor, agent-roster filtering,
 * dependency pruning (hallucinated + self edges), the roster prompt block, and
 * model resolution per tier.
 */
import { describe, it, expect, vi } from "vitest";
import { planTasks } from "./index";
import { modelForTier } from "../router/model-router";
import type { AgentAi } from "../ports";
import type { AgentDefinition } from "../fleet/types";

type RawTask = {
  id?: string;
  title: string;
  description: string;
  dependsOn?: string[];
  files?: string[];
  tier: "fast" | "balanced" | "precise";
  agent?: string;
};

function makeAi(tasks: RawTask[], capture?: { args?: unknown }): AgentAi {
  return {
    stream: vi.fn() as AgentAi["stream"],
    generateObject: vi.fn().mockImplementation((args: unknown) => {
      if (capture) capture.args = args;
      return Promise.resolve({
        object: { tasks },
        usage: { inputTokens: 20, outputTokens: 40 },
      });
    }),
  };
}

describe("planTasks", () => {
  it("produces a draft plan with the goal and resolved per-task models", async () => {
    const ai = makeAi([
      { id: "add-route", title: "Add route", description: "add a GET route", dependsOn: [], files: ["api.ts"], tier: "balanced" },
    ]);

    const plan = await planTasks({ goal: "add a listing endpoint", ai });

    expect(plan.status).toBe("draft");
    expect(plan.goal).toBe("add a listing endpoint");
    expect(plan.id).toMatch(/^plan_/);
    expect(plan.tasks).toHaveLength(1);
    const [task] = plan.tasks;
    expect(task!.id).toBe("add-route");
    expect(task!.tier).toBe("balanced");
    expect(task!.model).toBe(modelForTier("balanced"));
    expect(task!.status).toBe("queued");
  });

  it("escalates a task's tier when the router flags a high-stakes domain (never under-spend)", async () => {
    // The model proposed 'fast', but the description touches auth → precise floor wins.
    const ai = makeAi([
      { id: "auth", title: "Rework login", description: "change the auth session password flow", dependsOn: [], files: ["auth.ts"], tier: "fast" },
    ]);

    const plan = await planTasks({ goal: "harden auth", ai });
    expect(plan.tasks[0]!.tier).toBe("precise");
    expect(plan.tasks[0]!.model).toBe(modelForTier("precise"));
  });

  it("keeps the model's higher tier when the router would under-spend", async () => {
    // Description is mechanical → router says 'fast', but the model asked for 'precise'.
    const ai = makeAi([
      { id: "t1", title: "rename var", description: "rename a local variable", dependsOn: [], files: ["a.ts"], tier: "precise" },
    ]);

    const plan = await planTasks({ goal: "rename", ai });
    expect(plan.tasks[0]!.tier).toBe("precise");
  });

  it("backfills a missing id and de-duplicates repeated ids", async () => {
    const ai = makeAi([
      { title: "first", description: "do first", tier: "fast", files: [], dependsOn: [] },
      { id: "dup", title: "second", description: "do second", tier: "fast", files: [], dependsOn: [] },
      { id: "dup", title: "third", description: "do third", tier: "fast", files: [], dependsOn: [] },
    ]);

    const plan = await planTasks({ goal: "several things", ai });
    const ids = plan.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids[0]).toBe("task-1"); // backfilled from index
    expect(ids).toContain("dup");
    expect(ids[2]).toBe("dup-3"); // second "dup" gets a suffix
  });

  it("keeps an agent assignment only when it names a roster member", async () => {
    const roster: AgentDefinition[] = [
      { name: "db-expert", description: "database specialist", systemPrompt: "" },
    ];
    const ai = makeAi([
      { id: "a", title: "migrate", description: "add a table", tier: "balanced", files: [], dependsOn: [], agent: "db-expert" },
      { id: "b", title: "ghost", description: "do it", tier: "balanced", files: [], dependsOn: [], agent: "nonexistent" },
    ]);

    const plan = await planTasks({ goal: "db work", ai, agents: roster });
    expect(plan.tasks.find((t) => t.id === "a")!.agent).toBe("db-expert");
    expect(plan.tasks.find((t) => t.id === "b")!.agent).toBeUndefined();
  });

  it("drops dependencies that point at non-existent ids and self-edges", async () => {
    const ai = makeAi([
      { id: "a", title: "A", description: "do a", tier: "fast", files: [], dependsOn: ["ghost", "a"] },
      { id: "b", title: "B", description: "do b", tier: "fast", files: [], dependsOn: ["a"] },
    ]);

    const plan = await planTasks({ goal: "two tasks", ai });
    expect(plan.tasks.find((t) => t.id === "a")!.dependsOn).toEqual([]); // ghost + self removed
    expect(plan.tasks.find((t) => t.id === "b")!.dependsOn).toEqual(["a"]); // real dep kept
  });

  it("includes the agent roster in the planning prompt when agents are provided", async () => {
    const capture: { args?: unknown } = {};
    const roster: AgentDefinition[] = [
      { name: "db-expert", description: "database specialist", systemPrompt: "" },
    ];
    const ai = makeAi(
      [{ id: "a", title: "A", description: "do a", tier: "fast", files: [], dependsOn: [] }],
      capture,
    );

    await planTasks({ goal: "with roster", ai, agents: roster });
    const prompt = (capture.args as { prompt: string }).prompt;
    expect(prompt).toContain("Available specialized agents");
    expect(prompt).toContain("db-expert: database specialist");
  });

  it("honours a pinned planning model override", async () => {
    const capture: { args?: unknown } = {};
    const ai = makeAi(
      [{ id: "a", title: "A", description: "do a", tier: "fast", files: [], dependsOn: [] }],
      capture,
    );

    await planTasks({ goal: "pinned", ai, model: "openai/gpt-5" });
    expect((capture.args as { model: string }).model).toBe("openai/gpt-5");
  });
});
