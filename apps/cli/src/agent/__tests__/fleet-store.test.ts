/**
 * Plan store — proves plans and their tasks round-trip to disk, that re-saving a
 * plan replaces rather than duplicates it, and that history is bounded. Isolated
 * to a temp $HOME.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPlanStore } from "../fleet/store.js";
import { emptyUsage, type Plan, type Task } from "../fleet/types.js";

let home = "";
let prevHome = "";
const cwd = "/work/myproj";

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    description: id,
    status: "queued",
    dependsOn: [],
    files: [],
    tier: "balanced",
    model: "anthropic/claude-sonnet-4.6",
    createdAt: 1,
    usage: emptyUsage(),
    ...over,
  };
}

function plan(id: string, tasks: Task[]): Plan {
  return { id, goal: `goal ${id}`, createdAt: 1, tasks, status: "draft" };
}

beforeEach(() => {
  prevHome = process.env["HOME"] ?? "";
  home = mkdtempSync(join(tmpdir(), "oxagen-store-home-"));
  process.env["HOME"] = home;
});

afterEach(() => {
  process.env["HOME"] = prevHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("openPlanStore", () => {
  it("returns empty results before anything is saved", () => {
    const store = openPlanStore(cwd);
    expect(store.list()).toEqual([]);
    expect(store.get("nope")).toBeUndefined();
  });

  it("saves and reads a plan back", () => {
    const store = openPlanStore(cwd);
    const p = plan("p1", [task("a"), task("b")]);
    store.save(p);
    expect(store.get("p1")?.goal).toBe("goal p1");
    expect(store.list()).toHaveLength(1);
  });

  it("replaces a plan on re-save instead of duplicating", () => {
    const store = openPlanStore(cwd);
    store.save(plan("p1", [task("a")]));
    store.save(plan("p1", [task("a"), task("b")]));
    expect(store.list()).toHaveLength(1);
    expect(store.get("p1")?.tasks).toHaveLength(2);
  });

  it("updates a single task in place", () => {
    const store = openPlanStore(cwd);
    store.save(plan("p1", [task("a"), task("b")]));
    store.updateTask("p1", task("a", { status: "done", summary: "did it" }));
    const got = store.get("p1");
    expect(got?.tasks.find((t) => t.id === "a")?.status).toBe("done");
    expect(got?.tasks.find((t) => t.id === "b")?.status).toBe("queued");
  });

  it("sets a plan's lifecycle status", () => {
    const store = openPlanStore(cwd);
    store.save(plan("p1", [task("a")]));
    store.setStatus("p1", "completed");
    expect(store.get("p1")?.status).toBe("completed");
  });

  it("no-ops on updateTask/setStatus for an unknown plan", () => {
    const store = openPlanStore(cwd);
    expect(() => store.updateTask("ghost", task("a"))).not.toThrow();
    expect(() => store.setStatus("ghost", "failed")).not.toThrow();
  });

  it("bounds stored history to the 50 most recent plans", () => {
    const store = openPlanStore(cwd);
    for (let i = 0; i < 55; i++) store.save(plan(`p${i}`, [task("a")]));
    const list = store.list();
    expect(list).toHaveLength(50);
    // Newest first: p54 present, the earliest plans evicted.
    expect(list[0]?.id).toBe("p54");
    expect(list.some((p) => p.id === "p0")).toBe(false);
  });
});
