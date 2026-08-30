/**
 * Fleet cancel-drain — proves `drain()` is the safe alternative to `cancelAll()`
 * now that git isolation defaults on: dispatching new tasks stops immediately,
 * a task that never started is cancelled with no worktree ever spawned for it,
 * and a task already running is left alone to finish naturally so its worktree
 * goes through the normal checkpoint → integrate → dispose path — never torn
 * down mid-edit, never left behind. The isolation protocol itself is faked
 * (matching orchestrator-isolation.test.ts's style) so no git or filesystem is
 * touched; this only proves the orchestrator's call sequence.
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
import type {
  Isolation,
  IntegrationResult,
  Checkpoint,
} from "../fleet/git-isolation.js";
import type { Plan, Task } from "../fleet/types.js";

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

/** Records the protocol calls; never leaves a spawned worktree undisposed unless `keep`. */
function fakeIsolation(): Isolation & { calls: string[] } {
  const calls: string[] = [];
  const spawned = new Set<string>();
  const cp = (id: string): Checkpoint => ({
    taskId: id,
    hash: "h",
    ref: "r",
    message: "m",
  });
  return {
    calls,
    init: async () => void calls.push("init"),
    spawn: async (id) => {
      calls.push(`spawn:${id}`);
      spawned.add(id);
      return `/wt/${id}`;
    },
    checkpoint: async (id) => {
      calls.push(`checkpoint:${id}`);
      return cp(id);
    },
    recordedCommits: () => [],
    integrate: async (id) => {
      calls.push(`integrate:${id}`);
      return {
        ok: true,
        commit: "c",
        taskBranch: `b/${id}`,
      } satisfies IntegrationResult;
    },
    integrationRef: () => null,
    dispose: async (id, opts) => {
      calls.push(`dispose:${id}:keep=${opts?.keep ?? false}`);
      if (!opts?.keep) spawned.delete(id);
    },
    cleanupAll: async () => {
      calls.push("cleanupAll");
      spawned.clear();
    },
  };
}

describe("Fleet cancel-drain", () => {
  it("cancels a not-yet-started task immediately (no worktree ever spawned for it) and lets a running task finish + dispose normally", async () => {
    const iso = fakeIsolation();
    const gate = deferred();
    const runner: AgentRunner = async (o) => {
      if (o.prompt === "running") await gate.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    // concurrency 1: "running" starts immediately, "queued" never gets a slot.
    const fleet = new Fleet({
      cwd: "/repo",
      isolation: iso,
      runner,
      memory: null,
      concurrency: 1,
    });
    fleet.loadPlan(plan([task("running"), task("queued")]));
    const started = fleet.start();
    await flush();
    expect(statusOf(fleet, "running")).toBe("running");
    expect(statusOf(fleet, "queued")).toBe("queued");

    const drained = fleet.drain();

    // The queued task is cancelled synchronously — no spawn ever happened for it.
    expect(statusOf(fleet, "queued")).toBe("cancelled");
    expect(iso.calls.some((c) => c.startsWith("spawn:queued"))).toBe(false);
    // The running task is untouched — still running, not aborted.
    expect(statusOf(fleet, "running")).toBe("running");

    gate.resolve(undefined);
    await drained;
    await started; // start()'s promise settles on the same terminal state

    expect(statusOf(fleet, "running")).toBe("done");
    // Normal completion path: spawned, then checkpointed/integrated/disposed
    // without being kept — no orphan.
    expect(iso.calls).toEqual([
      "spawn:running",
      "checkpoint:running",
      "integrate:running",
      "dispose:running:keep=false",
    ]);
  });

  it("does not dispatch a cancelled task even when a running task's slot frees up", async () => {
    const iso = fakeIsolation();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const runner: AgentRunner = async (o) => {
      const g = gates.get(o.prompt) ?? deferred();
      gates.set(o.prompt, g);
      await g.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({
      cwd: "/repo",
      isolation: iso,
      runner,
      memory: null,
      concurrency: 1,
    });
    fleet.loadPlan(plan([task("a"), task("b"), task("c")]));
    const started = fleet.start();
    await flush();
    expect(statusOf(fleet, "a")).toBe("running");

    const drained = fleet.drain();
    expect(statusOf(fleet, "b")).toBe("cancelled");
    expect(statusOf(fleet, "c")).toBe("cancelled");

    // Freeing "a"'s slot must NOT resurrect b or c — draining means no new work.
    gates.get("a")?.resolve(undefined);
    await drained;
    await started;

    expect(statusOf(fleet, "a")).toBe("done");
    expect(statusOf(fleet, "b")).toBe("cancelled");
    expect(statusOf(fleet, "c")).toBe("cancelled");
    expect(iso.calls.some((c) => c.startsWith("spawn:b"))).toBe(false);
    expect(iso.calls.some((c) => c.startsWith("spawn:c"))).toBe(false);
    // Only "a" was ever spawned, and it was disposed — nothing orphaned.
    expect(iso.calls).toEqual([
      "spawn:a",
      "checkpoint:a",
      "integrate:a",
      "dispose:a:keep=false",
    ]);
  });

  it("resolves immediately when nothing was ever loaded or started", async () => {
    const fleet = new Fleet({
      cwd: "/repo",
      runner: async () => ({ text: "", steps: 0, usage: {} }),
    });
    await expect(fleet.drain()).resolves.toBeUndefined();
  });

  it("is idempotent — a second drain() call while already draining returns the same settlement", async () => {
    const gate = deferred();
    const runner: AgentRunner = async () => {
      await gate.promise;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 1 });
    fleet.loadPlan(plan([task("a")]));
    const started = fleet.start();
    await flush();

    const first = fleet.drain();
    const second = fleet.drain();
    gate.resolve(undefined);
    await Promise.all([first, second, started]);
    expect(statusOf(fleet, "a")).toBe("done");
  });
});
