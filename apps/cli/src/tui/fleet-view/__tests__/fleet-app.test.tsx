/**
 * Ink tests for the agents screen root. The fleet is a plain EventEmitter fake
 * of the Fleet surface FleetApp actually touches (snapshot / start / drain /
 * dispatchPrompt / loadPlan / "update" events), so renders are deterministic —
 * no engine, no gateway, no worktrees. Covered: immediate start + the honest
 * empty roster, update-event repaints, dispatch through the input line, the
 * Ctrl-T detail toggle, Ctrl-C cancel-drain (idempotent, exits once settled),
 * the planning banner for a goal, and the fatal planning-error frame. `exit`
 * is observed by spying on ink's useApp (ink-testing-library has no
 * waitUntilExit). Poll-with-deadline throughout; never fixed sleeps.
 */
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { FleetApp } from "../fleet-app.js";
import type { Fleet } from "../../../agent/fleet/orchestrator.js";
import type {
  AgentSnapshot,
  FleetSnapshot,
  Plan,
} from "../../../agent/fleet/types.js";

// Observe quit without a real TTY: spy on the `exit` the app calls, keeping
// the rest of ink real (same trick as the agent-view tests).
const exitMock = vi.hoisted(() => vi.fn());
vi.mock("ink", async (importActual) => {
  const actual = await importActual<typeof import("ink")>();
  return { ...actual, useApp: () => ({ exit: exitMock }) };
});

const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, "");

async function until(
  cond: () => boolean,
  timeoutMs = 3000,
  frame?: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      const tail = frame ? `\n--- last frame ---\n${frame()}` : "";
      throw new Error(`until(): condition not met in time${tail}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const emptySnap = (over: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
  agents: [],
  queuedCount: 0,
  runningCount: 0,
  doneCount: 0,
  failedCount: 0,
  totals: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  concurrency: 4,
  ...over,
});

const agentSnap = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  taskId: "t-1",
  title: "wire the rate limiter",
  tier: "balanced",
  model: "sonnet",
  status: "running",
  steps: 1,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  logTail: "",
  ...over,
});

/**
 * EventEmitter fake of the Fleet surface FleetApp consumes. Fleet is a
 * concrete class with private state, so the fake is bridged with a cast; the
 * members below are exactly the ones FleetApp calls.
 */
class FakeFleet extends EventEmitter {
  snap: FleetSnapshot = emptySnap();
  started = 0;
  drained = 0;
  dispatched: string[] = [];
  loadedPlans: Plan[] = [];
  private releaseDrain: (() => void) | null = null;

  snapshot(): FleetSnapshot {
    return this.snap;
  }

  async start(): Promise<void> {
    this.started += 1;
  }

  /** Holds until {@link finishDrain} so the draining banner is observable. */
  async drain(): Promise<void> {
    this.drained += 1;
    await new Promise<void>((resolve) => {
      this.releaseDrain = resolve;
    });
  }

  finishDrain(): void {
    this.releaseDrain?.();
  }

  dispatchPrompt(text: string): void {
    this.dispatched.push(text);
  }

  loadPlan(plan: Plan): void {
    this.loadedPlans.push(plan);
  }

  push(s: FleetSnapshot): void {
    this.snap = s;
    this.emit("update", s);
  }
}

const asFleet = (fake: FakeFleet): Fleet => fake as unknown as Fleet;

const mount = (
  fake: FakeFleet,
  extra: { goal?: string; plan?: (signal: AbortSignal) => Promise<Plan> } = {},
) => {
  const r = render(<FleetApp fleet={asFleet(fake)} {...extra} />);
  const plain = (): string => strip(r.lastFrame() ?? "");
  return { ...r, plain };
};

const planOf = (goal: string): Plan => ({
  id: "p-1",
  goal,
  createdAt: Date.now(),
  tasks: [],
  status: "draft",
});

describe("FleetApp", () => {
  it("starts the fleet immediately without a goal and shows the empty roster", async () => {
    const fake = new FakeFleet();
    const { plain, unmount } = mount(fake);
    await until(() => plain().includes("No agents yet"), 3000, plain);
    expect(fake.started).toBe(1);
    const frame = plain();
    expect(frame).toContain("OXAGEN"); // summary band mounted
    expect(frame).toContain("enter"); // footer key hints
    expect(frame).toContain("show detail");
    expect(frame).toContain("cancel · quit");
    expect(frame).not.toContain("TASK"); // no roster header with no agents
    unmount();
  });

  it("repaints the roster from fleet update events", async () => {
    const fake = new FakeFleet();
    const { plain, unmount } = mount(fake);
    await until(() => plain().includes("No agents yet"), 3000, plain);
    fake.push(
      emptySnap({
        agents: [agentSnap(), agentSnap({ taskId: "t-2", title: "write the docs", status: "queued" })],
        runningCount: 1,
        queuedCount: 1,
      }),
    );
    await until(() => plain().includes("wire the rate limiter"), 3000, plain);
    const frame = plain();
    expect(frame).toContain("TASK"); // roster header appears with agents
    expect(frame).toContain("write the docs");
    expect(frame).not.toContain("No agents yet");
    unmount();
  });

  it("typing + enter dispatches a new agent through the fleet", async () => {
    const fake = new FakeFleet();
    const { stdin, plain, unmount } = mount(fake);
    await until(() => plain().includes("No agents yet"), 3000, plain);
    stdin.write("fix the flaky test");
    await until(() => plain().includes("fix the flaky test"), 3000, plain);
    stdin.write("\r");
    await until(() => fake.dispatched.length === 1, 3000, plain);
    expect(fake.dispatched).toEqual(["fix the flaky test"]);
    unmount();
  });

  it("ctrl-t toggles the per-agent detail line and the footer hint", async () => {
    const fake = new FakeFleet();
    fake.snap = emptySnap({
      agents: [agentSnap({ status: "failed", error: "gateway said no" })],
      failedCount: 1,
    });
    const { stdin, plain, unmount } = mount(fake);
    await until(() => plain().includes("wire the rate limiter"), 3000, plain);
    expect(plain()).not.toContain("gateway said no");
    stdin.write("\u0014"); // Ctrl-T
    await until(() => plain().includes("gateway said no"), 3000, plain);
    expect(plain()).toContain("hide detail");
    stdin.write("\u0014");
    await until(() => !plain().includes("gateway said no"), 3000, plain);
    expect(plain()).toContain("show detail");
    unmount();
  });

  it("ctrl-c cancel-drains once (idempotent) and exits when the drain settles", async () => {
    const fake = new FakeFleet();
    fake.snap = emptySnap({ agents: [agentSnap()], runningCount: 1 });
    const { stdin, plain, unmount } = mount(fake);
    await until(() => plain().includes("wire the rate limiter"), 3000, plain);
    stdin.write("\u0003"); // Ctrl-C
    await until(() => plain().includes("Draining"), 3000, plain);
    expect(fake.drained).toBe(1);
    expect(plain()).toContain("waiting for 1 agent to finish");
    expect(plain()).toContain("draining…"); // footer flips
    // A second Ctrl-C while draining is a no-op — no second drain, no exit.
    stdin.write("\u0003");
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.drained).toBe(1);
    expect(exitMock).not.toHaveBeenCalled();
    fake.finishDrain();
    await until(() => exitMock.mock.calls.length > 0, 3000, plain);
    unmount();
  });

  it("plans a goal first, then loads the plan and starts the fleet", async () => {
    const fake = new FakeFleet();
    let resolvePlan!: (p: Plan) => void;
    const plan = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<Plan>((resolve) => {
          resolvePlan = resolve;
        }),
    );
    const { plain, unmount } = mount(fake, { goal: "add rate limiting", plan });
    await until(() => plain().includes("Planning"), 3000, plain);
    expect(plain()).toContain("add rate limiting");
    expect(fake.started).toBe(0); // not started until the plan lands
    expect(plain()).not.toContain("No agents yet"); // suppressed while planning
    resolvePlan(planOf("add rate limiting"));
    await until(() => fake.started === 1, 3000, plain);
    expect(fake.loadedPlans).toHaveLength(1);
    expect(fake.loadedPlans[0]?.goal).toBe("add rate limiting");
    await until(() => !plain().includes("Planning"), 3000, plain);
    unmount();
  });

  it("paints the fatal planning error and exits", async () => {
    const fake = new FakeFleet();
    const plan = vi.fn(async (_signal: AbortSignal): Promise<Plan> => {
      throw new Error("missing gateway key");
    });
    const { plain, unmount } = mount(fake, { goal: "add rate limiting", plan });
    await until(() => plain().includes("missing gateway key"), 3000, plain);
    expect(plain()).toContain("✗");
    expect(fake.started).toBe(0);
    await until(() => exitMock.mock.calls.length > 0, 3000, plain);
    unmount();
  });
});
