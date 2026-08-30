/**
 * Fleet ↔ isolation wiring — proves the orchestrator drives the isolation
 * protocol correctly without touching git: the agent runs in the spawned
 * worktree (not the shared tree), finished work is checkpointed then integrated,
 * conflicts are surfaced and the worktree kept, and — crucially — tasks that
 * predict the *same* files run in parallel under isolation instead of being
 * serialized. The git layer itself is covered in git-isolation.test.ts.
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

/** Records the protocol calls and returns canned integration results. */
function fakeIsolation(
  integrate?: (id: string) => IntegrationResult,
): Isolation & { calls: string[] } {
  const calls: string[] = [];
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
      return `/wt/${id}`;
    },
    checkpoint: async (id) => {
      calls.push(`checkpoint:${id}`);
      return cp(id);
    },
    recordedCommits: () => [],
    integrate: async (id) => {
      calls.push(`integrate:${id}`);
      return (
        integrate?.(id) ?? { ok: true, commit: "c", taskBranch: `b/${id}` }
      );
    },
    integrationRef: () => null,
    dispose: async (id, opts) =>
      void calls.push(`dispose:${id}:keep=${opts?.keep ?? false}`),
    cleanupAll: async () => void calls.push("cleanupAll"),
  };
}

describe("Fleet with git isolation", () => {
  it("runs the agent in its worktree, then checkpoints, integrates, disposes", async () => {
    const iso = fakeIsolation();
    let seenCwd = "";
    const runner: AgentRunner = async (o) => {
      seenCwd = o.cwd;
      return {
        text: "done",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };

    const fleet = new Fleet({
      cwd: "/repo",
      isolation: iso,
      runner,
      memory: null,
    });
    fleet.loadPlan(plan([task("t1")]));
    await fleet.start();

    expect(seenCwd).toBe("/wt/t1"); // ran in the worktree, not /repo
    expect(iso.calls).toEqual([
      "spawn:t1",
      "checkpoint:t1",
      "integrate:t1",
      "dispose:t1:keep=false",
    ]);
    expect(fleet.snapshot().agents[0]?.status).toBe("done");
  });

  it("surfaces an integration conflict and keeps the worktree", async () => {
    const iso = fakeIsolation(() => ({
      ok: false,
      conflicts: ["base.txt"],
      taskBranch: "b/t1",
      taskTip: "tip",
    }));
    const events: Array<{ taskId: string; conflicts?: string[] }> = [];
    const runner: AgentRunner = async () => ({
      text: "x",
      steps: 1,
      usage: {},
    });

    const fleet = new Fleet({
      cwd: "/repo",
      isolation: iso,
      runner,
      memory: null,
    });
    fleet.on("conflict", (e: { taskId: string; conflicts?: string[] }) =>
      events.push(e),
    );
    fleet.loadPlan(plan([task("t1")]));
    await fleet.start();

    expect(events).toHaveLength(1);
    expect(events[0]?.conflicts).toContain("base.txt");
    expect(iso.calls).toContain("dispose:t1:keep=true"); // kept for resolution
    const snap = fleet.snapshot().agents[0];
    expect(snap?.status).toBe("done");
    expect(snap?.error).toMatch(/integration conflict/);
  });

  it("runs same-file tasks in parallel under isolation (no file-lock serialization)", async () => {
    const iso = fakeIsolation();
    let active = 0;
    let maxActive = 0;
    const release = deferred();
    const bothRunning = deferred();
    const runner: AgentRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      if (active === 2) bothRunning.resolve();
      await release.promise;
      active--;
      return { text: "x", steps: 1, usage: {} };
    };

    const fleet = new Fleet({
      cwd: "/repo",
      concurrency: 4,
      isolation: iso,
      runner,
      memory: null,
    });
    // Both predict the SAME file — without isolation this would serialize.
    fleet.loadPlan(
      plan([task("t1", { files: ["x.ts"] }), task("t2", { files: ["x.ts"] })]),
    );
    const done = fleet.start();

    await bothRunning.promise;
    expect(maxActive).toBe(2);
    release.resolve();
    await done;
  });
});
