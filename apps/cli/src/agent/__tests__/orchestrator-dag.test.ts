/**
 * Fleet DAG scheduler — proves a genuine multi-dependency DAG schedules
 * correctly under concurrency, not just a single-dependency chain (already
 * covered by orchestrator.test.ts): independent tasks in the same ready-set
 * run concurrently (a real overlap, not accidental adjacency), a task with
 * MULTIPLE dependencies waits for every one of them (not just the first to
 * finish), and a wide fan-out is still bounded by the concurrency cap while
 * its shared dependent stays queued until the whole fan-out is done. The
 * coding loop is a fake runner (matching orchestrator.test.ts's style), so no
 * gateway or filesystem is touched.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
  }),
}));

import { Fleet, type AgentRunner } from "../fleet/orchestrator.js";
import type { Plan, Task } from "../fleet/types.js";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id, // the enhancer is mocked, so the runner sees this as its prompt
    status: "queued",
    dependsOn: [],
    files: [],
    tier: "fast",
    model: "anthropic/claude-haiku-4.5",
    createdAt: 1,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { id: "p1", goal: "g", createdAt: 1, tasks, status: "draft" };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function statusOf(fleet: Fleet, id: string): string | undefined {
  return fleet.snapshot().agents.find((a) => a.taskId === id)?.status;
}

describe("Fleet DAG scheduling", () => {
  it("overlaps independent tasks and holds a join task until BOTH its dependencies finish", async () => {
    const events: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const runner: AgentRunner = async (o) => {
      events.push(`start:${o.prompt}`);
      const g = gates.get(o.prompt) ?? deferred();
      gates.set(o.prompt, g);
      await g.promise;
      events.push(`end:${o.prompt}`);
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    fleet.loadPlan(
      plan([
        task("a"),
        task("b"),
        task("c", { dependsOn: ["a", "b"] }), // diamond join — needs BOTH
      ]),
    );
    const done = fleet.start();
    await flush();

    // a and b are the whole ready-set: both dispatched together, c held back.
    expect(fleet.snapshot().runningCount).toBe(2);
    expect(statusOf(fleet, "c")).toBe("queued");

    // Finishing only ONE dependency must not release the join task.
    gates.get("a")?.resolve(undefined);
    await flush();
    expect(statusOf(fleet, "a")).toBe("done");
    expect(statusOf(fleet, "c")).toBe("queued");
    expect(events).not.toContain("start:c");

    // Finishing the second dependency releases it.
    gates.get("b")?.resolve(undefined);
    await flush();
    expect(statusOf(fleet, "c")).toBe("running");

    gates.get("c")?.resolve(undefined);
    await done;

    // a and b were genuinely concurrent: b started before a ended.
    expect(events.indexOf("start:b")).toBeLessThan(events.indexOf("end:a"));
    // c only started after BOTH a and b had ended.
    expect(events.indexOf("end:a")).toBeLessThan(events.indexOf("start:c"));
    expect(events.indexOf("end:b")).toBeLessThan(events.indexOf("start:c"));
    expect(fleet.snapshot().doneCount).toBe(3);
  });

  it("bounds a wide fan-out by the concurrency cap, then runs the shared dependent once the whole fan-out is done", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
    // Pre-create every gate up front (including the dependent's) so resolving
    // one can never race the next task's runner call registering its own gate.
    for (const id of ["a", "b", "c", "join"]) gates.set(id, deferred());
    const runner: AgentRunner = async (o) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const g = gates.get(o.prompt) ?? deferred();
      gates.set(o.prompt, g);
      await g.promise;
      active--;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 2 });
    fleet.loadPlan(
      plan([
        task("a"),
        task("b"),
        task("c"),
        task("join", { dependsOn: ["a", "b", "c"] }),
      ]),
    );
    const done = fleet.start();
    await flush();

    // Only 2 of the 3 independent tasks run at once; join isn't even in the
    // ready-set yet (none of its deps are done).
    expect(fleet.snapshot().runningCount).toBe(2);
    expect(statusOf(fleet, "join")).toBe("queued");

    gates.get("a")?.resolve(undefined);
    await flush();
    // The freed slot goes to "c"; join is still blocked on b and c.
    expect(fleet.snapshot().runningCount).toBe(2);
    expect(statusOf(fleet, "a")).toBe("done");
    expect(statusOf(fleet, "join")).toBe("queued");

    gates.get("b")?.resolve(undefined);
    gates.get("c")?.resolve(undefined);
    await flush();
    expect(statusOf(fleet, "join")).toBe("running");

    gates.get("join")?.resolve(undefined);
    await done;

    expect(maxActive).toBe(2); // concurrency cap was never exceeded
    expect(fleet.snapshot().doneCount).toBe(4);
  });

  it("blocks every dependent transitively when a shared dependency fails", async () => {
    const runner: AgentRunner = async (o) => {
      if (o.prompt === "root") throw new Error("kaboom");
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    fleet.loadPlan(
      plan([
        task("root"),
        task("mid", { dependsOn: ["root"] }),
        task("leaf", { dependsOn: ["mid"] }), // depends on a task that will itself be blocked
      ]),
    );
    await fleet.start();

    expect(statusOf(fleet, "root")).toBe("failed");
    expect(statusOf(fleet, "mid")).toBe("blocked");
    expect(statusOf(fleet, "leaf")).toBe("blocked");
    expect(fleet.snapshot().failedCount).toBe(3);
  });

  it("cascades a multi-level block to completion within one pump, even when a task is listed before its transitive blocker", async () => {
    const runner: AgentRunner = async (o) => {
      if (o.prompt === "root") throw new Error("kaboom");
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    // "leaf" (depends on "mid") is inserted BEFORE "mid" (depends on "root") —
    // a non-topological order a real plan could produce. A single linear pass
    // over the task map would block "mid" but miss "leaf" in the same pass;
    // the fixed-point loop in pump() must still resolve both, or fleet.start()
    // would hang forever (leaf stuck at "queued", never terminal).
    fleet.loadPlan(
      plan([
        task("root"),
        task("leaf", { dependsOn: ["mid"] }),
        task("mid", { dependsOn: ["root"] }),
      ]),
    );
    await fleet.start(); // must settle — a regression here hangs the test until timeout

    expect(statusOf(fleet, "root")).toBe("failed");
    expect(statusOf(fleet, "mid")).toBe("blocked");
    expect(statusOf(fleet, "leaf")).toBe("blocked");
  });
});
