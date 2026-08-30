/**
 * Fleet orchestrator — proves the army schedules safely: dependencies gate
 * ordering, overlapping file ownership serializes agents, the concurrency cap is
 * honoured, a failed dependency blocks its dependents, and every finished task
 * records a two-axis memory. The coding loop is injected as a fake runner, so no
 * gateway or filesystem is touched. The prompt enhancer is mocked to a no-op.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prompt-enhancer.js", () => ({
  enhancePrompt: async ({ prompt }: { prompt: string }) => ({
    prompt,
    context: "",
    resolved: [],
    lessons: [],
  }),
}));

// Isolate from the developer's local ~/.config/oxagen/config.json so a pinned
// model in that file does not override the router and break tier-routing tests.
vi.mock("../../lib/config.js", () => ({
  readConfig: () => ({}),
  writeConfig: () => undefined,
}));

// Clear env-var tier overrides so the model router uses the catalog defaults,
// not whatever the developer has pinned in their shell.
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

import { Fleet, type AgentRunner } from "../fleet/orchestrator.js";
import type { FleetMemory } from "../fleet/memory.js";
import type { ServerMemory } from "../adapters/memory-provider.js";
import type { RecalledMemory } from "../../lib/memory-client.js";
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
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

function fakeMemory(): FleetMemory & { record: ReturnType<typeof vi.fn> } {
  return { record: vi.fn(), recall: () => [], all: () => [] };
}

function statusOf(fleet: Fleet, id: string): string | undefined {
  return fleet.snapshot().agents.find((a) => a.taskId === id)?.status;
}

describe("Fleet scheduling", () => {
  it("runs a dependent task only after its dependency completes", async () => {
    const events: string[] = [];
    const runner: AgentRunner = async (o) => {
      events.push(`start:${o.prompt}`);
      await Promise.resolve();
      events.push(`end:${o.prompt}`);
      return {
        text: `did ${o.prompt}`,
        steps: 2,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    fleet.loadPlan(plan([task("t1"), task("t2", { dependsOn: ["t1"] })]));
    await fleet.start();

    expect(events.indexOf("end:t1")).toBeLessThan(events.indexOf("start:t2"));
    expect(statusOf(fleet, "t1")).toBe("done");
    expect(statusOf(fleet, "t2")).toBe("done");
  });

  it("respects the concurrency cap", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
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
    // Pre-create gates so resolving them releases task "c" too, even though it
    // only starts (and would otherwise create its gate) after a/b complete.
    for (const id of ["a", "b", "c"]) gates.set(id, deferred());
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 2 });
    fleet.loadPlan(plan([task("a"), task("b"), task("c")]));
    const done = fleet.start();
    await flush();

    expect(fleet.snapshot().runningCount).toBe(2);
    for (const g of gates.values()) g.resolve(undefined);
    await done;
    expect(maxActive).toBe(2);
    expect(fleet.snapshot().doneCount).toBe(3);
  });

  it("serializes tasks whose files overlap", async () => {
    let active = 0;
    let maxActive = 0;
    const gates = new Map<string, ReturnType<typeof deferred>>();
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
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 4 });
    fleet.loadPlan(
      plan([
        task("t1", { files: ["shared.ts"] }),
        task("t2", { files: ["shared.ts"] }),
      ]),
    );
    const done = fleet.start();
    await flush();

    // Only one of the two file-conflicting tasks may run at a time.
    expect(fleet.snapshot().runningCount).toBe(1);
    gates.get("t1")?.resolve(undefined);
    await flush();
    expect(fleet.snapshot().runningCount).toBe(1); // now t2
    gates.get("t2")?.resolve(undefined);
    await done;
    expect(maxActive).toBe(1);
    expect(fleet.snapshot().doneCount).toBe(2);
  });

  it("blocks dependents when a dependency fails, and records the failure", async () => {
    const memory = fakeMemory();
    const runner: AgentRunner = async (o) => {
      if (o.prompt === "t1") throw new Error("kaboom");
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, memory });
    fleet.loadPlan(plan([task("t1"), task("t2", { dependsOn: ["t1"] })]));
    await fleet.start();

    expect(statusOf(fleet, "t1")).toBe("failed");
    expect(statusOf(fleet, "t2")).toBe("blocked");
    expect(fleet.snapshot().failedCount).toBe(2); // failed + blocked
    expect(memory.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", memoryKind: "gotcha" }),
    );
  });

  it("records a success memory and accumulates token cost", async () => {
    const memory = fakeMemory();
    const runner: AgentRunner = async () => ({
      text: "rewired the thing",
      steps: 3,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    const fleet = new Fleet({ cwd: "/x", runner, memory });
    fleet.loadPlan(
      plan([
        task("fix-bug", { title: "fix the bug", description: "fix the bug" }),
      ]),
    );
    await fleet.start();

    expect(memory.record).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "success",
        memoryKind: "bug-root-cause",
      }),
    );
    // 1M Haiku input tokens = $1.00.
    expect(fleet.snapshot().totals.costUsd).toBeCloseTo(1, 6);
  });

  it("dispatches an ad-hoc prompt and routes its model", async () => {
    const runner: AgentRunner = async (o) => ({
      text: `did ${o.prompt}`,
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const fleet = new Fleet({ cwd: "/x", runner });
    const id = fleet.dispatchPrompt("rename a local variable");
    await fleet.start();
    const agent = fleet.snapshot().agents.find((a) => a.taskId === id);
    expect(agent?.status).toBe("done");
    expect(agent?.model).toContain("haiku"); // trivial → fast tier
  });

  it("cancelAll aborts in-flight agents and settles", async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const runner: AgentRunner = async (o) => {
      const g = gates.get(o.prompt) ?? deferred();
      gates.set(o.prompt, g);
      await new Promise<void>((resolve, reject) => {
        o.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        void g.promise.then(() => resolve());
      });
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, concurrency: 2 });
    fleet.loadPlan(
      plan([task("a", { files: ["a.ts"] }), task("b", { files: ["b.ts"] })]),
    );
    const done = fleet.start();
    await flush();
    expect(fleet.snapshot().runningCount).toBe(2);

    fleet.cancelAll();
    await done;
    expect(fleet.snapshot().doneCount).toBe(0);
    expect(fleet.snapshot().agents.every((a) => a.status === "cancelled")).toBe(
      true,
    );
  });

  it("emits an update snapshot on changes", async () => {
    const runner: AgentRunner = async () => ({
      text: "ok",
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const fleet = new Fleet({ cwd: "/x", runner });
    const seen: number[] = [];
    fleet.on("update", (snap) => seen.push(snap.agents.length));
    fleet.loadPlan(plan([task("a")]));
    await fleet.start();
    expect(seen.length).toBeGreaterThan(0);
  });
});

function fakeServer(recallRows: RecalledMemory[] = []): ServerMemory & {
  recall: ReturnType<typeof vi.fn>;
  remember: ReturnType<typeof vi.fn>;
} {
  return {
    recall: vi.fn().mockResolvedValue(recallRows),
    remember: vi.fn(),
  };
}

describe("Fleet platform memory", () => {
  it("gives each subagent a memory provider that recalls the workspace lessons for its task", async () => {
    const server = fakeServer([
      {
        id: "m1",
        nodeRef: "coding-agent",
        memoryClass: "RULE",
        memoryKind: "gotcha",
        lesson: "use withTenantDb, never raw db()",
        source: "fix",
        confidenceScore: 90,
        enforcementScore: 95,
        score: 0.9,
        createdAt: "2026-07-01T00:00:00Z",
      },
    ]);
    let recalledForRunner = "";
    const runner: AgentRunner = async (o) => {
      recalledForRunner = o.memory ? await o.memory.recallContext() : "";
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, serverMemory: server });
    fleet.loadPlan(plan([task("t1", { description: "wire the db access" })]));
    await fleet.start();

    expect(server.recall).toHaveBeenCalledWith("wire the db access");
    expect(recalledForRunner).toContain("## Lessons from prior sessions");
    expect(recalledForRunner).toContain("use withTenantDb, never raw db()");
  });

  it("mirrors a finished task's lesson to the platform on success and failure", async () => {
    const server = fakeServer();
    const runner: AgentRunner = async (o) => {
      if (o.prompt === "boom") throw new Error("kaboom");
      return {
        text: "rewired the thing",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner, serverMemory: server });
    fleet.loadPlan(
      plan([
        task("ok", { title: "fix the bug", description: "fix the bug" }),
        task("boom", { title: "risky", description: "boom" }),
      ]),
    );
    await fleet.start();

    const kinds = server.remember.mock.calls.map((c) => c[0]);
    expect(kinds).toContain("bug-root-cause"); // success on a fix task
    expect(kinds).toContain("gotcha"); // failure
  });

  it("passes no memory provider to the runner when no server handle is configured", async () => {
    let sawMemory: unknown = "unset";
    const runner: AgentRunner = async (o) => {
      sawMemory = o.memory;
      return {
        text: "ok",
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    };
    const fleet = new Fleet({ cwd: "/x", runner });
    fleet.loadPlan(plan([task("t1")]));
    await fleet.start();
    expect(sawMemory).toBeNull();
  });
});
