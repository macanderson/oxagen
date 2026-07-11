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
    reg.register({
      kind: "turn",
      title: "add rate limiting",
      model: "anthropic/claude-sonnet-5",
    });
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
    const h = reg.register({ kind: "subagent", title: "CI run 42" });
    h.update({ detail: "polling", outputTokens: 128 });
    expect(reg.snapshot()[0]).toMatchObject({
      detail: "polling",
      outputTokens: 128,
    });
    h.done("failed");
    expect(reg.snapshot()[0]?.status).toBe("failed");
  });

  it("sorts active agents before finished ones", () => {
    const { reg, advance } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "first" });
    advance(10);
    reg.register({ kind: "subagent", title: "second" });
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
    reg.register({ kind: "subagent", title: "queued", status: "queued" });
    reg.register({ kind: "subagent", title: "boom" }).done("failed");
    expect(reg.summary()).toMatchObject({
      total: 3,
      running: 1,
      queued: 1,
      failed: 1,
    });
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

  it("remove() drops one entry from the roster and no-ops on unknown ids", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "keep" });
    const b = reg.register({ kind: "subagent", title: "dismiss" });
    reg.remove(b.id);
    expect(reg.snapshot().map((e) => e.id)).toEqual([a.id]);
    reg.remove("does-not-exist"); // no throw, no change
    expect(reg.snapshot().map((e) => e.id)).toEqual([a.id]);
  });

  it("remove() notifies subscribers only when it actually deletes", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "x" });
    const listener = vi.fn();
    reg.on(listener);
    reg.remove("nope");
    expect(listener).not.toHaveBeenCalled();
    reg.remove(a.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ── Kill seam ──────────────────────────────────────────────────────────────

  it("kill() fires a registered AbortController, marks 'killed', keeps it visible, and returns true", () => {
    const { reg } = makeRegistry();
    const ctrl = new AbortController();
    const a = reg.register({ kind: "turn", title: "long turn" });
    expect(reg.registerAbort(a.id, ctrl)).toBe(true);

    const hadHandle = reg.kill(a.id);
    expect(hadHandle).toBe(true); // an abort handle existed and was fired
    expect(ctrl.signal.aborted).toBe(true); // real work was cancelled
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1); // still visible — not auto-removed
    expect(snap[0]?.status).toBe("killed");
  });

  it("kill() accepts a bare abort function handle", () => {
    const { reg } = makeRegistry();
    const abort = vi.fn();
    const a = reg.register({ kind: "subagent", title: "poller" });
    reg.registerAbort(a.id, abort);
    expect(reg.kill(a.id)).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(reg.snapshot()[0]?.status).toBe("killed");
  });

  it("register({ abort }) wires the handle up front", () => {
    const { reg } = makeRegistry();
    const ctrl = new AbortController();
    const a = reg.register({ kind: "turn", title: "up-front", abort: ctrl });
    expect(reg.kill(a.id)).toBe(true);
    expect(ctrl.signal.aborted).toBe(true);
  });

  it("kill() with no abort handle still marks 'killed' but returns false", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "handle-less" });
    expect(reg.kill(a.id)).toBe(false); // nothing to abort
    expect(reg.snapshot()[0]?.status).toBe("killed"); // but transitioned anyway
  });

  it("kill() is a no-op returning false for an unknown id", () => {
    const { reg } = makeRegistry();
    const listener = vi.fn();
    reg.on(listener);
    expect(reg.kill("ghost")).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("registerAbort() returns false for an unknown id", () => {
    const { reg } = makeRegistry();
    expect(reg.registerAbort("ghost", new AbortController())).toBe(false);
  });

  it("a throwing abort handle never wedges the registry — the entry is still killed", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "throws on abort" });
    reg.registerAbort(a.id, () => {
      throw new Error("abort blew up");
    });
    expect(() => reg.kill(a.id)).not.toThrow();
    expect(reg.kill(a.id)).toBe(false); // handle consumed by the first kill
    expect(reg.snapshot()[0]?.status).toBe("killed");
  });

  it("a killed entry lingers under the TTL, then is pruned", () => {
    const { reg, advance } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "kill me" });
    reg.registerAbort(a.id, new AbortController());
    reg.kill(a.id);
    advance(4_999);
    expect(reg.snapshot()).toHaveLength(1); // within TTL — visible
    advance(2);
    expect(reg.snapshot()).toHaveLength(0); // past TTL — pruned
  });

  it("kill() notifies subscribers", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "x" });
    const listener = vi.fn();
    reg.on(listener);
    reg.kill(a.id);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("remove() drops the abort handle so a subsequent kill can't fire it", () => {
    const { reg } = makeRegistry();
    const ctrl = new AbortController();
    const a = reg.register({ kind: "turn", title: "dismiss then kill" });
    reg.registerAbort(a.id, ctrl);
    reg.remove(a.id);
    expect(reg.kill(a.id)).toBe(false); // entry gone
    expect(ctrl.signal.aborted).toBe(false); // handle never fired
  });

  it("summary() counts killed entries", () => {
    const { reg } = makeRegistry();
    const a = reg.register({ kind: "turn", title: "victim" });
    reg.register({ kind: "turn", title: "survivor" });
    reg.kill(a.id);
    expect(reg.summary()).toMatchObject({ total: 2, running: 1, killed: 1 });
  });
});
