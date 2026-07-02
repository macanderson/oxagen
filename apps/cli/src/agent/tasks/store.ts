/**
 * User task store — the durable, user-managed to-do list behind the REPL's Task
 * Progress panel.
 *
 * Unlike the fleet {@link ../fleet/store PlanStore} (which mirrors what the agent
 * army is *executing*), this is a list the human owns: they add tasks, edit their
 * details, reorder them, cycle their status, and delete them from the panel with
 * the keyboard. Agents may also append tasks here (so "remember to do X" survives
 * the turn), but the human is always in control.
 *
 * Persistence mirrors the rest of the CLI's per-project state: one JSON file at
 * `~/.config/oxagen/tasks/<project>.json`, keyed by the working-directory name,
 * rewritten on every mutation (best-effort — the list still works from memory if
 * the disk write fails). The store is an {@link EventEmitter}: the panel
 * subscribes and re-renders on every change, exactly like the agent registry.
 *
 * The store is deliberately framework-free (no Ink, no React) so it is trivially
 * unit-testable and can be driven from anywhere in the CLI.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Lifecycle of a user task. Cycles todo → active → done and back with a keypress. */
export type UserTaskStatus = "todo" | "active" | "done" | "blocked";

/** The status ring the panel cycles through on the "toggle status" key. */
export const TASK_STATUS_CYCLE: readonly UserTaskStatus[] = [
  "todo",
  "active",
  "done",
] as const;

/** A single user-owned task. */
export interface UserTask {
  id: string;
  /** One-line title — what the panel shows as the task. */
  title: string;
  /** Optional longer detail (acceptance notes, context) shown when expanded. */
  detail?: string;
  status: UserTaskStatus;
  createdAt: number;
  updatedAt: number;
}

/** The fields a caller may set when adding a task. */
export interface AddTaskInput {
  title: string;
  detail?: string;
  status?: UserTaskStatus;
}

/** The fields an edit may patch. */
export type TaskPatch = Partial<Pick<UserTask, "title" | "detail" | "status">>;

interface StoreShape {
  tasks: UserTask[];
}

function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

function defaultStorePath(cwd: string): string {
  return join(homedir(), ".config", "oxagen", "tasks", `${projectKey(cwd)}.json`);
}

/** The next status when cycling; wraps around the ring. Unknown → first entry. */
export function nextStatus(status: UserTaskStatus): UserTaskStatus {
  const idx = TASK_STATUS_CYCLE.indexOf(status);
  if (idx === -1) return TASK_STATUS_CYCLE[0] as UserTaskStatus;
  return TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length] as UserTaskStatus;
}

export interface TaskStoreOptions {
  /** Injectable clock (ms epoch) for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Override the persistence path (tests point this at a temp file). */
  path?: string;
  /** Disable disk persistence entirely (pure in-memory; for tests). */
  persist?: boolean;
}

/**
 * The user task store. One instance per REPL session, created from the working
 * directory; the Task Progress panel subscribes to it and drives it.
 */
export class TaskStore extends EventEmitter {
  private tasks: UserTask[] = [];
  private readonly now: () => number;
  private readonly path: string | null;
  private counter = 0;

  constructor(cwd: string, opts: TaskStoreOptions = {}) {
    super();
    this.setMaxListeners(0);
    this.now = opts.now ?? (() => Date.now());
    this.path = opts.persist === false ? null : (opts.path ?? defaultStorePath(cwd));
    this.load();
  }

  /** Current tasks, in display order (insertion order; newest appended last). */
  list(): UserTask[] {
    return [...this.tasks];
  }

  /** Number of tasks — handy for the panel header. */
  count(): number {
    return this.tasks.length;
  }

  /** Add a task to the end of the list and persist. Returns the created task. */
  add(input: AddTaskInput): UserTask {
    const at = this.now();
    const task: UserTask = {
      id: `task-${at.toString(36)}-${++this.counter}`,
      title: input.title.trim() || "(untitled task)",
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      status: input.status ?? "todo",
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.push(task);
    this.commit();
    return task;
  }

  /** Patch a task's fields (merged) and persist. No-op for an unknown id. */
  update(id: string, patch: TaskPatch): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    if (patch.title !== undefined) task.title = patch.title.trim() || task.title;
    if (patch.detail !== undefined) task.detail = patch.detail;
    if (patch.status !== undefined) task.status = patch.status;
    task.updatedAt = this.now();
    this.commit();
  }

  /** Cycle a task's status (todo → active → done → todo) and persist. */
  cycleStatus(id: string): void {
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return;
    task.status = nextStatus(task.status);
    task.updatedAt = this.now();
    this.commit();
  }

  /** Remove a task by id and persist. Returns true when a task was removed. */
  remove(id: string): boolean {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    const removed = this.tasks.length !== before;
    if (removed) this.commit();
    return removed;
  }

  /**
   * Move a task one slot toward the start (`-1`) or end (`+1`) of the list and
   * persist. Clamped at the ends; a no-op move never emits.
   */
  move(id: string, direction: -1 | 1): void {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const target = idx + direction;
    if (target < 0 || target >= this.tasks.length) return;
    const [task] = this.tasks.splice(idx, 1);
    this.tasks.splice(target, 0, task as UserTask);
    this.commit();
  }

  /** Remove every task and persist. */
  clear(): void {
    if (this.tasks.length === 0) return;
    this.tasks = [];
    this.commit();
  }

  /** Subscribe to any change. Returns an unsubscribe fn. */
  on(_event: "change", listener: () => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  /** Convenience subscribe that returns an unsubscribe fn (matches the registry). */
  subscribe(listener: () => void): () => void {
    super.on("change", listener);
    return () => super.off("change", listener);
  }

  private commit(): void {
    this.save();
    this.emit("change");
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as StoreShape;
      if (Array.isArray(data.tasks)) {
        this.tasks = data.tasks.filter(
          (t): t is UserTask =>
            !!t && typeof t.id === "string" && typeof t.title === "string",
        );
      }
    } catch {
      /* corrupt/unreadable file — start from an empty list */
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ tasks: this.tasks }, null, 2), "utf8");
    } catch {
      /* persistence is best-effort; the list still works from memory */
    }
  }
}

/** Open the user task store for a working directory. */
export function openTaskStore(cwd: string, opts: TaskStoreOptions = {}): TaskStore {
  return new TaskStore(cwd, opts);
}
