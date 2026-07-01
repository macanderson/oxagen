/**
 * AgentRegistry — proves the process-wide running-agent registry that powers
 * `/hud`: registration, live updates, terminal retirement, snapshot ordering,
 * TTL pruning of finished entries, and change notifications.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentRegistry } from "../agent-registry.js";

/** A registry with a hand-cranked clock so TTL/ordering are deterministic. */
function makeRegistry(startMs = 1_000) {
  let clock = startMs;
  const reg = new AgentRegistry({ now: () => clock, finishedTtlMs: 5_000 });
  return { reg, advance: (ms: number) => (clock += ms), at: () => clock };
}

describe("AgentRegistry", () => {
  it("registers an agent and exposes it in the snapshot", () => {
    const { reg } = makeRegistry();
    reg.register({ kind: "turn", title: "add rate limiting", model: "anthropic/claude-sonnet-5" });
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      kind: "turn",
      title: "add rate limiting",
      model: "anthropic/claude-sonnet-5",
      status: "running",
    });
  });

  it("update() patches fields and done() marks terminal", () => {
    const { reg } = makeRegistry();
    const h = reg.register({ kind: "monitor", title: "CI run 42" });
    h.update({ detail: "polling", outputTokens: 128 });
    expect(reg.snapshot()[0]).toMatchObject({ detail: "polling", outputTokens: 128 });
    h.done("failed");
    expect(reg.snapshot()[0]?.status).toBe("failed");
  });

  it("sorts active agents before finished ones", () => {
    const { reg, advance } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "first" });
    advance(10);
    reg.register({ kind: "monitor", title: "second" });
    advance(10);
    a.done(); // finish the older one
    const titles = reg.snapshot().map((x) => x.title);
    // The still-running "second" comes before the just-finished "first".
    expect(titles).toEqual(["second", "first"]);
  });

  it("prunes finished agents only after the TTL elapses", () => {
    const { reg, advance } = makeRegistry();
    const h = reg.register({ kind: "turn", title: "done soon" });
    h.done();
    advance(4_999);
    expect(reg.snapshot()).toHaveLength(1); // still within TTL — visible
    advance(2);
    expect(reg.snapshot()).toHaveLength(0); // past TTL — pruned
  });

  it("late update() after pruning is a silent no-op", () => {
    const { reg, advance } = makeRegistry();
    const h = reg.register({ kind: "turn", title: "gone" });
    h.done();
    advance(6_000);
    expect(reg.snapshot()).toHaveLength(0);
    expect(() => h.update({ detail: "too late" })).not.toThrow();
    expect(reg.snapshot()).toHaveLength(0);
  });

  it("summary() counts by status", () => {
    const { reg } = makeRegistry();
    reg.register({ kind: "turn", title: "run" });
    reg.register({ kind: "monitor", title: "queued", status: "queued" });
    reg.register({ kind: "subagent", title: "boom" }).done("failed");
    expect(reg.summary()).toMatchObject({ total: 3, running: 1, queued: 1, failed: 1 });
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const { reg } = makeRegistry();
    const listener = vi.fn();
    const unsub = reg.on(listener);
    reg.register({ kind: "turn", title: "x" });
    expect(listener).toHaveBeenCalled();
    const countAfterRegister = listener.mock.calls.length;
    unsub();
    reg.register({ kind: "turn", title: "y" });
    expect(listener.mock.calls.length).toBe(countAfterRegister);
  });
});
