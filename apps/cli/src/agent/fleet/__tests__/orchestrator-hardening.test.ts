/**
 * Fleet orchestrator hardening — proves the scheduler can't wedge:
 *
 *   1. A dispose() throw in the run() finally still frees the task's slot, so
 *      the next queued task dispatches (the slot is never lost to a phantom
 *      occupant), and the error is surfaced on the "scheduler-error" channel.
 *   2. A store.setStatus() throw at completion still settles the fleet — start()
 *      resolves, it never hangs on an unresolved donePromise.
 *   3. A dynamic concurrencyProvider is consulted on every refill: lowering it
 *      mid-run stops NEW dispatches while running tasks finish; raising it
 *      refills up to the new (clamped) cap.
 *
 * The coding loop is an injected fake runner; the enhancer and config are
 * mocked, so no gateway or user config is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
  }),
}));

vi.mock("../../../lib/config.js", () => ({
  readConfig: () => ({}),
  writeConfig: () => undefined,
}));

beforeEach(() => {
  for (const key of [
    "OXAGEN_LLM_FAST",
    "OXAGEN_LLM_BALANCED",
    "OXAGEN_LLM_PRECISE",
    "OXAGEN_MODEL",
  ]) {
    delete process.env[key];
  }
});

import { Fleet, type AgentRunner } from "../orchestrator.js";
import type { Isolation } from "../git-isolation.js";
import type { PlanStore } from "../store.js";
import type { Plan, Task } from "../types.js";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

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

function statusOf(fleet: Fleet, id: string): string | undefined {
  return fleet.snapshot().agents.find((a) => a.taskId === id)?.status;
}

const okRunner: AgentRunner = async () => ({
  text: "ok",
  steps: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
});

describe("Fleet hardening — a throwing teardown never wedges the fleet", () => {
  it("frees the slot and dispatches the next task when dispose() throws", async () => {
    const isolation: Isolation = {
      init: async () => undefined,
      spawn: async () => "/work",
      checkpoint: async () => null,
      recordedCommits: () => [],
      integrate: async (taskId) => ({ ok: true, taskBranch: `task/${taskId}` }),
      integrationRef: () => null,
      dispose: async () => {
        throw new Error("dispose kaboom");
      },
      cleanupAll: async () => undefined,
    };
    const schedErrors: Array<{ phase: string; message: string }> = [];
    const fleet = new Fleet({
      cwd: "/x",
      runner: okRunner,
      concurrency: 1,
      isolation,
    });
    fleet.on("scheduler-error", (e: { phase: string; message: string }) =>
      schedErrors.push(e),
    );

    // Two independent tasks, one slot: the second only runs if the first's
    // slot was released despite dispose() throwing in its finally.
    fleet.loadPlan(plan([task("a"), task("b")]));
    await fleet.start();

    expect(statusOf(fleet, "a")).toBe("done");
    expect(statusOf(fleet, "b")).toBe("done");
    expect(schedErrors.some((e) => e.phase === "dispose")).toBe(true);
  });

  it("still settles start() when store.setStatus throws at completion", async () => {
    // Throw only on the terminal transition; the "executing" set during
    // loadPlan must succeed so the plan loads.
    const store: PlanStore = {
      save: () => undefined,
      get: () => undefined,
      list: () => [],
      updateTask: () => undefined,
      setStatus: (_id, status) => {
        if (status === "completed" || status === "failed")
          throw new Error("disk full");
      },
    };
    const schedErrors: Array<{ phase: string; message: string }> = [];
    const fleet = new Fleet({ cwd: "/x", runner: okRunner, store });
    fleet.on("scheduler-error", (e: { phase: string; message: string }) =>
      schedErrors.push(e),
    );

    fleet.loadPlan(plan([task("a")]));
    await fleet.start(); // must resolve, not hang

    expect(statusOf(fleet, "a")).toBe("done");
    expect(schedErrors.some((e) => e.phase === "store.setStatus")).toBe(true);
  });
});

describe("Fleet hardening — dynamic concurrencyProvider", () => {
  it("lowering mid-run halts new dispatch; raising refills", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());
    const runner: AgentRunner = async (o) => {
      await gates.get(o.prompt)!.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };

    let cap = 2;
    const fleet = new Fleet({
      cwd: "/x",
      runner,
      concurrency: 4, // ceiling
      concurrencyProvider: () => cap,
    });
    fleet.loadPlan(plan([task("a"), task("b"), task("c")]));
    const done = fleet.start();
    await flush();

    // Provider = 2 → exactly two running, c waits.
    expect(fleet.snapshot().runningCount).toBe(2);

    // Lower to 1 and let a finish. Its completion re-pumps, but running (b) is
    // already at the new cap, so c must NOT start.
    cap = 1;
    gates.get("a")!.resolve(undefined);
    await flush();
    expect(fleet.snapshot().runningCount).toBe(1);
    expect(statusOf(fleet, "c")).toBe("queued");

    // Raise to 3 and let b finish. Its completion re-pumps against the new cap
    // and c dispatches.
    cap = 3;
    gates.get("b")!.resolve(undefined);
    await flush();
    expect(statusOf(fleet, "c")).toBe("running");

    gates.get("c")!.resolve(undefined);
    await done;
    expect(fleet.snapshot().doneCount).toBe(3);
  });

  it("clamps a provider value to [1, concurrency]", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    for (const id of ["a", "b", "c", "d", "e"]) gates.set(id, deferred());
    const runner: AgentRunner = async (o) => {
      await gates.get(o.prompt)!.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    // Provider asks for 99 but the ceiling is 3 → never more than 3 running.
    const fleet = new Fleet({
      cwd: "/x",
      runner,
      concurrency: 3,
      concurrencyProvider: () => 99,
    });
    fleet.loadPlan(plan(["a", "b", "c", "d", "e"].map((id) => task(id))));
    const done = fleet.start();
    await flush();
    expect(fleet.snapshot().runningCount).toBe(3);
    for (const g of gates.values()) g.resolve(undefined);
    await done;
    expect(fleet.snapshot().doneCount).toBe(5);
  });

  it("degrades a NaN provider value to the configured ceiling", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());
    const runner: AgentRunner = async (o) => {
      await gates.get(o.prompt)!.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({
      cwd: "/x",
      runner,
      concurrency: 2,
      concurrencyProvider: () => Number.NaN,
    });
    fleet.loadPlan(plan([task("a"), task("b"), task("c")]));
    const done = fleet.start();
    await flush();
    expect(fleet.snapshot().runningCount).toBe(2); // fell back to ceiling 2
    for (const g of gates.values()) g.resolve(undefined);
    await done;
    expect(fleet.snapshot().doneCount).toBe(3);
  });
});
