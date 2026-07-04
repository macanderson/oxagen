/**
 * fleet-turn.test.ts — the REPL turn's fleet fan-out wrapper.
 *
 * Uses an injected fake Fleet (no gateway, no git) to verify the wrapper's
 * contract: plan loaded, events forwarded, abort → cancelAll, per-task summary
 * text, and listener cleanup.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { runFleetTurn, summarizeFleetRun } from "../fleet-turn.js";
import type { Fleet, FleetOptions, FleetTaskEvent } from "../../agent/fleet/orchestrator.js";
import { emptyUsage, type FleetSnapshot, type Plan, type Task } from "../../agent/fleet/types.js";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: `Do ${id}`,
    status: "queued",
    dependsOn: [],
    files: [],
    tier: "fast",
    model: "test-model",
    createdAt: 1,
    usage: emptyUsage(),
    ...overrides,
  };
}

function makePlan(tasks: Task[]): Plan {
  return { id: "plan_1", goal: "goal", createdAt: 1, tasks, status: "draft" };
}

function makeSnapshot(agents: FleetSnapshot["agents"]): FleetSnapshot {
  return {
    agents,
    queuedCount: agents.filter((a) => a.status === "queued").length,
    runningCount: agents.filter((a) => a.status === "running").length,
    doneCount: agents.filter((a) => a.status === "done").length,
    failedCount: agents.filter((a) => a.status === "failed" || a.status === "blocked").length,
    totals: agents.reduce(
      (acc, a) => ({
        inputTokens: acc.inputTokens + a.usage.inputTokens,
        outputTokens: acc.outputTokens + a.usage.outputTokens,
        costUsd: acc.costUsd + a.usage.costUsd,
      }),
      emptyUsage(),
    ),
    concurrency: 4,
  };
}

/** A fake Fleet: start() replays a scripted task lifecycle, then settles. */
class FakeFleet extends EventEmitter {
  loadedPlan: Plan | null = null;
  cancelled = false;
  constructor(private readonly script: (fleet: FakeFleet) => void) {
    super();
  }
  loadPlan(plan: Plan): void {
    this.loadedPlan = plan;
  }
  start(): Promise<void> {
    this.script(this);
    return Promise.resolve();
  }
  cancelAll(): void {
    this.cancelled = true;
  }
  snapshot(): FleetSnapshot {
    const tasks = this.loadedPlan?.tasks ?? [];
    return makeSnapshot(
      tasks.map((t) => ({
        taskId: t.id,
        title: t.title,
        tier: t.tier,
        model: t.model,
        status: t.status,
        steps: 0,
        usage: t.usage,
        logTail: "",
        error: t.error,
      })),
    );
  }
}

function taskEvent(task: Task, status: Task["status"]): FleetTaskEvent {
  return {
    taskId: task.id,
    status,
    title: task.title,
    tier: task.tier,
    model: task.model,
    usage: task.usage,
  };
}

describe("runFleetTurn", () => {
  it("loads the plan, forwards task events, and summarizes the outcome", async () => {
    const a = makeTask("a");
    const b = makeTask("b");
    const plan = makePlan([a, b]);
    const seen: Array<{ id: string; status: string }> = [];

    const fake = new FakeFleet((fleet) => {
      a.status = "done";
      a.summary = "built the route";
      fleet.emit("task", taskEvent(a, "running"));
      fleet.emit("task", taskEvent(a, "done"));
      b.status = "failed";
      b.error = "boom";
      fleet.emit("task", taskEvent(b, "running"));
      fleet.emit("task", taskEvent(b, "failed"));
    });

    const result = await runFleetTurn({
      plan,
      cwd: "/tmp/repo",
      fleetFactory: () => fake as unknown as Fleet,
      isolationFactory: async () => null,
      onTask: (ev) => seen.push({ id: ev.taskId, status: ev.status }),
    });

    expect(fake.loadedPlan).toBe(plan);
    expect(seen).toEqual([
      { id: "a", status: "running" },
      { id: "a", status: "done" },
      { id: "b", status: "running" },
      { id: "b", status: "failed" },
    ]);
    expect(result.failedCount).toBe(1);
    expect(result.summaryText).toContain("✓ Task a — built the route");
    expect(result.summaryText).toContain("✗ Task b");
    expect(result.summaryText).toContain("1/2 tasks done, 1 failed");
  });

  it("cancels every task when the turn signal aborts", async () => {
    const plan = makePlan([makeTask("a")]);
    const controller = new AbortController();
    const fake = new FakeFleet((fleet) => {
      controller.abort();
      // Simulate the orchestrator settling after the cancel.
      fleet.emit("task", taskEvent(plan.tasks[0]!, "cancelled"));
    });

    await runFleetTurn({
      plan,
      cwd: "/tmp/repo",
      signal: controller.signal,
      fleetFactory: () => fake as unknown as Fleet,
      isolationFactory: async () => null,
    });
    expect(fake.cancelled).toBe(true);
  });

  it("cancels immediately when the signal is already aborted", async () => {
    const plan = makePlan([makeTask("a")]);
    const controller = new AbortController();
    controller.abort();
    const fake = new FakeFleet(() => {});
    await runFleetTurn({
      plan,
      cwd: "/tmp/repo",
      signal: controller.signal,
      fleetFactory: () => fake as unknown as Fleet,
      isolationFactory: async () => null,
    });
    expect(fake.cancelled).toBe(true);
  });

  it("removes its listeners when the run settles", async () => {
    const plan = makePlan([makeTask("a")]);
    const fake = new FakeFleet(() => {});
    await runFleetTurn({
      plan,
      cwd: "/tmp/repo",
      fleetFactory: () => fake as unknown as Fleet,
      isolationFactory: async () => null,
      onTask: () => {},
      onUpdate: () => {},
    });
    expect(fake.listenerCount("task")).toBe(0);
    expect(fake.listenerCount("update")).toBe(0);
  });

  it("persists the plan to the store before execution", async () => {
    const plan = makePlan([makeTask("a")]);
    const saved: Plan[] = [];
    const fake = new FakeFleet(() => {});
    await runFleetTurn({
      plan,
      cwd: "/tmp/repo",
      store: { save: (p: Plan) => void saved.push(p) } as never,
      fleetFactory: () => fake as unknown as Fleet,
      isolationFactory: async () => null,
    });
    expect(saved).toEqual([plan]);
  });
});

describe("summarizeFleetRun", () => {
  it("renders one line per task plus a totals line", () => {
    const a = makeTask("a", { status: "done", summary: "ok" });
    const b = makeTask("b", { status: "blocked" });
    const plan = makePlan([a, b]);
    const snapshot = makeSnapshot([
      {
        taskId: "a",
        title: a.title,
        tier: a.tier,
        model: a.model,
        status: "done",
        steps: 3,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
        logTail: "",
      },
      {
        taskId: "b",
        title: b.title,
        tier: b.tier,
        model: b.model,
        status: "blocked",
        steps: 0,
        usage: emptyUsage(),
        logTail: "",
      },
    ]);
    const text = summarizeFleetRun(plan, snapshot);
    expect(text).toContain("✓ Task a — ok");
    expect(text).toContain("⊘ Task b");
    expect(text).toContain("100 in / 50 out tokens");
    expect(text).toContain("$0.0100");
  });
});
