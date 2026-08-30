/**
 * The process-wide task registry — the single source of truth for "what is the
 * planning agent working through right now", powering the REPL's live
 * **Task Progress** side panel.
 *
 * Where {@link agentRegistry} tracks *who* is running (the lead turn agent, its
 * subagents, background monitors — the "Agent Team"), this tracks *what work* the
 * turn's planning/coordinator agent laid out and how far each item has gotten.
 * The REPL's pipeline stages (evaluate → enhance → route → execute → judge →
 * complete) are recorded here as an ordered checklist that advances live; a
 * future generative planner can seed the same list.
 *
 * Like the agent registry this is a lightweight in-memory singleton scoped to the
 * current process — not a cross-process store. Finished items linger briefly so a
 * completion is visible before the list is reset for the next turn.
 */
import { EventEmitter } from "node:events";

export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

/** A live view of one planned task. */
export interface TrackedTask {
  /** Stable id (a stage kind, a task slug) — used to upsert without duplicating. */
  id: string;
  /** Human title — the work, never a raw id. */
  title: string;
  status: TaskStatus;
  /** Insertion order; the panel renders ascending so the plan reads top-to-bottom. */
  order: number;
  /** Short live detail: current sub-step, target, note. */
  detail?: string;
  /** ms epoch when first seen. */
  createdAt: number;
  /** ms epoch of the last mutation. */
  updatedAt: number;
}

/** The mutable fields a producer may patch on a task. */
export type TaskPatch = Partial<
  Pick<TrackedTask, "title" | "status" | "detail">
>;

/** Aggregate counts for the panel header. */
export interface TaskSummary {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "done",
  "failed",
]);

export interface TaskRegistryOptions {
  /** Injectable clock (ms epoch) for deterministic tests. Default Date.now. */
  now?: () => number;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TrackedTask>();
  private readonly bus = new EventEmitter();
  private readonly now: () => number;
  private counter = 0;

  constructor(opts: TaskRegistryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    // A busy turn upserts many stages; lift the listener cap so no spurious warning.
    this.bus.setMaxListeners(0);
  }

  /**
   * Create or update a task by id. New ids are appended in call order; existing
   * ids are patched in place (so a stage can go pending → in_progress → done
   * without ever duplicating a row).
   */
  upsert(id: string, patch: { title: string } & TaskPatch): TrackedTask {
    const at = this.now();
    const cur = this.tasks.get(id);
    if (cur) {
      Object.assign(cur, patch, { updatedAt: at });
      this.emitChange();
      return cur;
    }
    const task: TrackedTask = {
      id,
      title: patch.title,
      status: patch.status ?? "pending",
      order: this.counter++,
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(id, task);
    this.emitChange();
    return task;
  }

  /** Patch an existing task; no-op if the id is unknown. */
  update(id: string, patch: TaskPatch): void {
    const cur = this.tasks.get(id);
    if (!cur) return;
    Object.assign(cur, patch, { updatedAt: this.now() });
    this.emitChange();
  }

  /**
   * Mark every not-yet-terminal task terminal in one shot — used at turn end so a
   * plan never lingers half-lit. Defaults each open task to "done"; pass "failed"
   * when the turn errored out.
   */
  finalizeOpen(status: "done" | "failed" = "done"): void {
    let changed = false;
    const at = this.now();
    for (const t of this.tasks.values()) {
      if (!TERMINAL.has(t.status)) {
        t.status = status;
        t.updatedAt = at;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  /** Current tasks in plan order. */
  snapshot(): TrackedTask[] {
    return [...this.tasks.values()].sort((a, b) => a.order - b.order);
  }

  /** Aggregate counts for the panel header. */
  summary(): TaskSummary {
    const list = this.snapshot();
    return {
      total: list.length,
      pending: list.filter((t) => t.status === "pending").length,
      running: list.filter((t) => t.status === "in_progress").length,
      done: list.filter((t) => t.status === "done").length,
      failed: list.filter((t) => t.status === "failed").length,
    };
  }

  /** Subscribe to any change. Returns an unsubscribe fn. */
  on(listener: () => void): () => void {
    this.bus.on("change", listener);
    return () => this.bus.off("change", listener);
  }

  /**
   * Drop a single task by id — powers the REPL panel's "delete highlighted
   * task" (Ctrl-X twice). No-op if the id is unknown. Ordering of the survivors
   * is preserved (their `order` values are untouched, so the plan still reads
   * top-to-bottom around the gap).
   */
  remove(id: string): void {
    if (this.tasks.delete(id)) this.emitChange();
  }

  /** Drop every task and reset ordering — called at the start of each turn. */
  clear(): void {
    this.tasks.clear();
    this.counter = 0;
    this.emitChange();
  }

  private emitChange(): void {
    this.bus.emit("change");
  }
}

/**
 * The process-wide singleton the REPL turn writes and the Task Progress panel
 * reads. One instance means every stage of the active turn surfaces in one panel.
 */
export const taskRegistry = new TaskRegistry();
