/**
 * TaskRegistry — proves the Task Progress source of truth: tasks upsert by id
 * without duplicating, advance through statuses, snapshot in plan order, and
 * finalize/clear cleanly, and that subscribers are notified on every change.
 */
import { describe, it, expect, vi } from "vitest";
import { TaskRegistry } from "../task-registry.js";

let clock = 1_000;
const now = (): number => clock;

function fresh(): TaskRegistry {
  clock = 1_000;
  return new TaskRegistry({ now });
}

describe("TaskRegistry", () => {
  it("appends new tasks in call order and defaults to pending", () => {
    const reg = fresh();
    reg.upsert("evaluate", { title: "Evaluate the request" });
    reg.upsert("execute", { title: "Execute the work" });
    const snap = reg.snapshot();
    expect(snap.map((t) => t.id)).toEqual(["evaluate", "execute"]);
    expect(snap[0]?.status).toBe("pending");
    expect(snap[0]?.order).toBeLessThan(snap[1]?.order ?? Infinity);
  });

  it("upserts an existing id in place instead of duplicating", () => {
    const reg = fresh();
    reg.upsert("execute", { title: "Execute the work", status: "pending" });
    reg.upsert("execute", {
      title: "Execute the work",
      status: "in_progress",
      detail: "editing",
    });
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.status).toBe("in_progress");
    expect(snap[0]?.detail).toBe("editing");
  });

  it("update patches a known id and no-ops an unknown one", () => {
    const reg = fresh();
    reg.upsert("judge", { title: "Judge the result", status: "in_progress" });
    reg.update("judge", { status: "done" });
    reg.update("missing", { status: "failed" });
    const snap = reg.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]?.status).toBe("done");
  });

  it("finalizeOpen marks every non-terminal task terminal, leaving done/failed alone", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A", status: "done" });
    reg.upsert("b", { title: "B", status: "in_progress" });
    reg.upsert("c", { title: "C", status: "pending" });
    reg.finalizeOpen("done");
    const byId = Object.fromEntries(
      reg.snapshot().map((t) => [t.id, t.status]),
    );
    expect(byId).toEqual({ a: "done", b: "done", c: "done" });
  });

  it("summary counts each status", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A", status: "done" });
    reg.upsert("b", { title: "B", status: "in_progress" });
    reg.upsert("c", { title: "C", status: "pending" });
    reg.upsert("d", { title: "D", status: "failed" });
    expect(reg.summary()).toEqual({
      total: 4,
      pending: 1,
      running: 1,
      done: 1,
      failed: 1,
    });
  });

  it("clear empties the registry and resets ordering", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A" });
    reg.clear();
    expect(reg.snapshot()).toEqual([]);
    reg.upsert("b", { title: "B" });
    expect(reg.snapshot()[0]?.order).toBe(0);
  });

  it("notifies subscribers on change and stops after unsubscribe", () => {
    const reg = fresh();
    const listener = vi.fn();
    const unsub = reg.on(listener);
    reg.upsert("a", { title: "A" });
    reg.update("a", { status: "done" });
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
    reg.upsert("b", { title: "B" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stamps updatedAt from the injected clock", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A" });
    clock = 5_000;
    reg.update("a", { status: "done" });
    expect(reg.snapshot()[0]?.updatedAt).toBe(5_000);
  });

  it("remove() drops one task, keeps the rest in order, and no-ops on unknown ids", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A" });
    reg.upsert("b", { title: "B" });
    reg.upsert("c", { title: "C" });
    reg.remove("b");
    expect(reg.snapshot().map((t) => t.id)).toEqual(["a", "c"]);
    // Unknown id is a no-op (no throw, no change).
    reg.remove("zzz");
    expect(reg.snapshot().map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("remove() notifies subscribers only when it actually deletes", () => {
    const reg = fresh();
    reg.upsert("a", { title: "A" });
    const listener = vi.fn();
    reg.on(listener);
    reg.remove("nope"); // unknown → no notification
    expect(listener).not.toHaveBeenCalled();
    reg.remove("a"); // real delete → one notification
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
