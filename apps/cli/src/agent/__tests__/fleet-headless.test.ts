/**
 * Headless fleet runner (`oxagen agents --json`) — proves the JSONL contract:
 * a "plan" line describing the DAG, a "task" line for every lifecycle
 * transition, a "conflict" line when isolation reports one, cancel-drain on
 * SIGINT (no orphaned worktree, no further dispatch), and a final "summary"
 * envelope. The coding loop is a fake runner and isolation is faked, matching
 * the rest of the fleet test suite's style — no gateway, git, or filesystem.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
  }),
}));

import { Fleet, type AgentRunner } from "../fleet/orchestrator.js";
import { runFleetHeadless } from "../fleet/headless.js";
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

function plan(id: string, goal: string, tasks: Task[]): Plan {
  return { id, goal, createdAt: 1, tasks, status: "draft" };
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

/** Collects each JSONL line, pre-parsed, in emission order. */
function lineSink(): {
  write: (line: string) => void;
  events: Array<Record<string, unknown>>;
} {
  const events: Array<Record<string, unknown>> = [];
  return {
    write: (line) => events.push(JSON.parse(line) as Record<string, unknown>),
    events,
  };
}

// process is a shared EventEmitter across the whole worker — always let
// runFleetHeadless's own `finally` remove its listeners, but assert none leak
// past a test as a belt-and-suspenders check.
afterEach(() => {
  expect(process.listenerCount("SIGINT")).toBe(0);
  expect(process.listenerCount("SIGTERM")).toBe(0);
});

describe("runFleetHeadless", () => {
  it("emits a plan line, a task line per lifecycle transition, and a final summary", async () => {
    const runner: AgentRunner = async (o) => ({
      text: `did ${o.prompt}`,
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    const p = plan("p1", "ship the thing", [
      task("a"),
      task("b", { dependsOn: ["a"] }),
    ]);

    const sink = lineSink();
    const snap = await runFleetHeadless({
      fleet,
      plan: async () => p,
      write: sink.write,
    });

    expect(snap.doneCount).toBe(2);

    const planLine = sink.events.find((e) => e["type"] === "plan");
    expect(planLine).toMatchObject({ planId: "p1", goal: "ship the thing" });
    expect(planLine?.["tasks"]).toEqual([
      { id: "a", title: "a", dependsOn: [], files: [], tier: "fast" },
      { id: "b", title: "b", dependsOn: ["a"], files: [], tier: "fast" },
    ]);

    const taskLines = sink.events.filter((e) => e["type"] === "task");
    // Every task passes through queued (on load) then running then done.
    const statusesFor = (id: string): unknown[] =>
      taskLines.filter((e) => e["taskId"] === id).map((e) => e["status"]);
    expect(statusesFor("a")).toEqual(["queued", "running", "done"]);
    expect(statusesFor("b")).toEqual(["queued", "running", "done"]);
    // b's "running" event must come after a's "done" — proves the JSONL
    // stream reflects the real dependency order, not just insertion order.
    const bRunningIdx = taskLines.findIndex(
      (e) => e["taskId"] === "b" && e["status"] === "running",
    );
    const aDoneIdx = taskLines.findIndex(
      (e) => e["taskId"] === "a" && e["status"] === "done",
    );
    expect(aDoneIdx).toBeLessThan(bRunningIdx);

    const summary = sink.events.at(-1);
    expect(summary).toMatchObject({
      type: "summary",
      planId: "p1",
      goal: "ship the thing",
      doneCount: 2,
      failedCount: 0,
      queuedCount: 0,
      runningCount: 0,
    });
    expect((summary?.["tasks"] as unknown[]).length).toBe(2);
  });

  it("runs a fleet with a plan already loaded (no `plan` callback) and emits no plan line", async () => {
    const runner: AgentRunner = async () => ({
      text: "ok",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const fleet = new Fleet({ cwd: "/x", runner });
    fleet.loadPlan(plan("p2", "g", [task("solo")]));

    const sink = lineSink();
    const snap = await runFleetHeadless({ fleet, write: sink.write });

    expect(snap.doneCount).toBe(1);
    expect(sink.events.some((e) => e["type"] === "plan")).toBe(false);
    expect(sink.events.some((e) => e["type"] === "summary")).toBe(true);
  });

  it("emits a conflict line when isolation reports a merge conflict", async () => {
    const iso: Isolation = {
      init: async () => undefined,
      spawn: async (id) => `/wt/${id}`,
      checkpoint: async (id): Promise<Checkpoint> => ({
        taskId: id,
        hash: "h",
        ref: "r",
        message: "m",
      }),
      recordedCommits: () => [],
      integrate: async (id): Promise<IntegrationResult> => ({
        ok: false,
        conflicts: ["base.txt"],
        taskBranch: `b/${id}`,
        taskTip: "tip",
      }),
      integrationRef: () => null,
      dispose: async () => undefined,
      cleanupAll: async () => undefined,
    };
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
    fleet.loadPlan(plan("p3", "g", [task("t1")]));

    const sink = lineSink();
    await runFleetHeadless({ fleet, write: sink.write });

    const conflict = sink.events.find((e) => e["type"] === "conflict");
    expect(conflict).toMatchObject({
      taskId: "t1",
      ok: false,
      conflicts: ["base.txt"],
    });
  });

  it("cancel-drains on SIGINT: emits a draining line, stops new dispatch, and still finishes the in-flight task cleanly", async () => {
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
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 1 });
    fleet.loadPlan(plan("p4", "g", [task("running"), task("queued")]));

    const sink = lineSink();
    const resultPromise = runFleetHeadless({ fleet, write: sink.write });
    await flush();

    process.emit("SIGINT");
    await flush();

    expect(sink.events.some((e) => e["type"] === "draining")).toBe(true);
    expect(
      fleet.snapshot().agents.find((a) => a.taskId === "queued")?.status,
    ).toBe("cancelled");

    gate.resolve(undefined);
    const snap = await resultPromise;

    expect(snap.doneCount).toBe(1); // "running" finished normally
    expect(snap.agents.find((a) => a.taskId === "queued")?.status).toBe(
      "cancelled",
    );
    const summary = sink.events.at(-1);
    expect(summary).toMatchObject({ type: "summary", doneCount: 1 });
  });
});
