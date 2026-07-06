/**
 * Fleet orchestrator — the subagent army scheduler.
 *
 * The `AgentRunner` and `MemoryProvider` are injected fakes (no gateway, no real
 * workspace), so these tests drive the orchestrator's own guarantees: dependency
 * gating, file-ownership serialization, the concurrency cap, ad-hoc dispatch,
 * cancellation (queued + running-via-abort), snapshot accounting, and the
 * success/failure memory records.
 */
import { describe, it, expect, vi } from "vitest";
import type { ToolSet } from "ai";
import { Fleet } from "./index";
import type { AgentRunner } from "./index";
import type { Plan, Task } from "./types";
import { emptyUsage } from "../types";

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id, // enhancePrompt is a no-op without codeGraph/memory, so runner sees this verbatim
    status: "queued",
    dependsOn: [],
    files: [],
    tier: "fast",
    model: "anthropic/claude-haiku-4.5",
    createdAt: Date.now(),
    usage: emptyUsage(),
    ...over,
  };
}

function plan(tasks: Task[]): Plan {
  return { id: "p1", goal: "g", createdAt: Date.now(), tasks, status: "draft" };
}

const okRunner: AgentRunner = async () => ({ text: "ok", steps: 2, usage: { inputTokens: 10, outputTokens: 5 } });

describe("Fleet — basic execution", () => {
  it("runs a loaded plan to completion and reports done in the snapshot", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();

    const snap = fleet.snapshot();
    expect(snap.doneCount).toBe(1);
    expect(snap.runningCount).toBe(0);
    expect(snap.agents[0]!.status).toBe("done");
    expect(snap.agents[0]!.steps).toBe(2); // runner reported 2 steps
  });

  it("emits an update snapshot as tasks progress", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    const updates: number[] = [];
    fleet.on("update", (s: { doneCount: number }) => updates.push(s.doneCount));
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1]).toBe(1);
  });
});

describe("Fleet — dependencies", () => {
  it("waits for a dependency to finish before starting a dependent task", async () => {
    const order: string[] = [];
    const runner: AgentRunner = async ({ prompt }) => {
      order.push(prompt);
      return { text: "ok", steps: 1, usage: {} };
    };
    const fleet = new Fleet({ cwd: "/repo", runner });
    fleet.loadPlan(plan([task("a"), task("b", { dependsOn: ["a"] })]));
    await fleet.start();
    expect(order).toEqual(["a", "b"]);
  });

  it("blocks a task whose dependency failed", async () => {
    const runner: AgentRunner = async ({ prompt }) => {
      if (prompt === "a") throw new Error("boom");
      return { text: "ok", steps: 1, usage: {} };
    };
    const remember = vi.fn();
    const fleet = new Fleet({
      cwd: "/repo",
      runner,
      memory: { recallContext: async () => "", remember },
    });
    fleet.loadPlan(plan([task("a"), task("b", { dependsOn: ["a"] })]));
    await fleet.start();

    const snap = fleet.snapshot();
    const a = snap.agents.find((x) => x.taskId === "a")!;
    const b = snap.agents.find((x) => x.taskId === "b")!;
    expect(a.status).toBe("failed");
    expect(a.error).toBe("boom");
    expect(b.status).toBe("blocked");
    // failedCount folds in blocked tasks.
    expect(snap.failedCount).toBe(2);
    // A failed task records a gotcha memory.
    expect(remember).toHaveBeenCalledWith(
      "gotcha",
      expect.objectContaining({ taskId: "a" }),
      "failure",
    );
  });
});

describe("Fleet — safety serialization", () => {
  it("serializes tasks with overlapping file ownership (never two agents on one file)", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: AgentRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { text: "ok", steps: 1, usage: {} };
    };
    const fleet = new Fleet({ cwd: "/repo", runner, concurrency: 4 });
    fleet.loadPlan(plan([task("a", { files: ["shared.ts"] }), task("b", { files: ["shared.ts"] })]));
    await fleet.start();
    expect(maxActive).toBe(1);
    expect(fleet.snapshot().doneCount).toBe(2);
  });

  it("never runs more than the concurrency cap at once", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: AgentRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return { text: "ok", steps: 1, usage: {} };
    };
    const fleet = new Fleet({ cwd: "/repo", runner, concurrency: 2 });
    fleet.loadPlan(plan([task("a"), task("b"), task("c")]));
    await fleet.start();
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(fleet.snapshot().doneCount).toBe(3);
  });
});

describe("Fleet — ad-hoc dispatch", () => {
  it("dispatches a typed prompt as a new task and runs it", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    const id = fleet.dispatchPrompt("investigate the flaky test in src/foo.ts");
    expect(id).toBe("adhoc-1");
    await fleet.start();
    const snap = fleet.snapshot();
    expect(snap.doneCount).toBe(1);
    expect(snap.agents[0]!.taskId).toBe("adhoc-1");
  });

  it("truncates a very long ad-hoc prompt into the task title", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    const longPrompt = "x".repeat(200);
    const id = fleet.dispatchPrompt(longPrompt);
    await fleet.start();
    const title = fleet.snapshot().agents.find((a) => a.taskId === id)!.title;
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("Fleet — cancellation", () => {
  it("cancels a queued task before it runs", async () => {
    // Gate the first task so the second stays queued while we cancel it.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const runner: AgentRunner = async ({ prompt }) => {
      if (prompt === "a") await gate;
      return { text: "ok", steps: 1, usage: {} };
    };
    const fleet = new Fleet({ cwd: "/repo", runner, concurrency: 1 });
    fleet.loadPlan(plan([task("a"), task("b")]));
    const done = fleet.start();
    await tick();
    fleet.cancelTask("b"); // b is still queued behind a
    release();
    await done;

    const snap = fleet.snapshot();
    expect(snap.agents.find((x) => x.taskId === "b")!.status).toBe("cancelled");
    expect(snap.agents.find((x) => x.taskId === "a")!.status).toBe("done");
  });

  it("cancels a running task through its abort signal", async () => {
    const runner: AgentRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const fleet = new Fleet({ cwd: "/repo", runner });
    fleet.loadPlan(plan([task("a")]));
    const done = fleet.start();
    await tick();
    fleet.cancelTask("a");
    await done;
    await tick();
    expect(fleet.snapshot().agents[0]!.status).toBe("cancelled");
  });

  it("cancelTask is a no-op on an unknown or already-terminal task", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();
    // Both of these must not throw and must not change the terminal state.
    fleet.cancelTask("does-not-exist");
    fleet.cancelTask("a"); // already done
    expect(fleet.snapshot().agents[0]!.status).toBe("done");
  });

  it("cancelAll cancels everything in flight", async () => {
    const runner: AgentRunner = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const fleet = new Fleet({ cwd: "/repo", runner, concurrency: 4 });
    fleet.loadPlan(plan([task("a"), task("b")]));
    const done = fleet.start();
    await tick();
    fleet.cancelAll();
    await done;
    await tick();
    const snap = fleet.snapshot();
    expect(snap.agents.every((a) => a.status === "cancelled")).toBe(true);
  });
});

describe("Fleet — accounting + memory", () => {
  it("sums token/cost totals across finished agents", async () => {
    const fleet = new Fleet({ cwd: "/repo", runner: okRunner });
    fleet.loadPlan(plan([task("a"), task("b")]));
    await fleet.start();
    const { totals } = fleet.snapshot();
    // Two tasks × {10 in, 5 out} each.
    expect(totals.inputTokens).toBe(20);
    expect(totals.outputTokens).toBe(10);
    expect(totals.costUsd).toBeGreaterThan(0);
  });

  it("records a bug-root-cause memory for a fix task and routine-change otherwise", async () => {
    const remember = vi.fn();
    const fleet = new Fleet({
      cwd: "/repo",
      runner: okRunner,
      memory: { recallContext: async () => "", remember },
    });
    fleet.loadPlan(
      plan([
        task("fixit", { title: "fix the login regression" }),
        task("feature", { title: "add a settings page" }),
      ]),
    );
    await fleet.start();

    const kinds = remember.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("bug-root-cause");
    expect(kinds).toContain("routine-change");
  });
});

describe("Fleet — governance seams threaded to each subagent (ADR-021 §5)", () => {
  it("passes budgetGuard, memory, fileLock, extraTools, wrapTools + a per-task lockContext", async () => {
    const received: Array<Parameters<AgentRunner>[0]> = [];
    const runner: AgentRunner = async (opts) => {
      received.push(opts);
      return { text: "ok", steps: 1, usage: { inputTokens: 1, outputTokens: 1 } };
    };

    const budgetGuard = vi.fn(async () => "continue" as const);
    const wrapTools: (t: ToolSet) => ToolSet = vi.fn((t: ToolSet) => t);
    const extraTools = {} as ToolSet;
    const memory = { recallContext: vi.fn(async () => ""), remember: vi.fn(async () => undefined) };
    const fileLock = {
      acquire: vi.fn(async () => ({ granted: true, lockId: "l1", heldBy: null, blockedUntil: null })),
      release: vi.fn(),
      releaseAll: vi.fn(),
    };

    const fleet = new Fleet({
      cwd: "/repo",
      runner,
      memory,
      fileLock,
      extraTools,
      wrapTools,
      budgetGuard,
      executionId: "exec-1",
    });
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();

    expect(received).toHaveLength(1);
    const opts = received[0]!;
    expect(opts.budgetGuard).toBe(budgetGuard);
    expect(opts.memory).toBe(memory);
    expect(opts.fileLock).toBe(fileLock);
    expect(opts.extraTools).toBe(extraTools);
    expect(opts.wrapTools).toBe(wrapTools);
    // Per-task lock identity: distinct agentId (carries the task id), shared executionId.
    expect(opts.lockContext).toEqual({ agentId: "exec-1:a", executionId: "exec-1" });
  });

  it("omits lockContext when no fileLock is injected (CLI default — unlocked)", async () => {
    const received: Array<Parameters<AgentRunner>[0]> = [];
    const runner: AgentRunner = async (opts) => {
      received.push(opts);
      return { text: "ok", steps: 1, usage: {} };
    };
    const fleet = new Fleet({ cwd: "/repo", runner });
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();

    expect(received[0]!.fileLock).toBeNull();
    expect(received[0]!.lockContext).toBeUndefined();
  });
});
