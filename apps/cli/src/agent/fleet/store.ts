/**
 * Plan persistence — durable storage for plans and their tasks.
 *
 * Plans live as JSON under `~/.config/oxagen/fleet/<project>.json` (one file per
 * project, keyed by the working-directory name, consistent with the other CLI
 * state). Persisting plans lets a dispatched fleet survive a crashed TUI and lets
 * `oxagen agents` show what's in flight from a previous run.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Plan, Task } from "./types.js";

function projectKey(cwd: string): string {
  return basename(cwd) || "default";
}

function storePath(cwd: string): string {
  return join(
    homedir(),
    ".config",
    "oxagen",
    "fleet",
    `${projectKey(cwd)}.json`,
  );
}

interface StoreShape {
  plans: Plan[];
}

function read(cwd: string): StoreShape {
  const path = storePath(cwd);
  if (!existsSync(path)) return { plans: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoreShape;
  } catch {
    return { plans: [] };
  }
}

function write(cwd: string, data: StoreShape): void {
  const path = storePath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    // Persistence is best-effort — a failed write must never break the fleet —
    // but leave a breadcrumb under OXAGEN_DEBUG so a silently-dropped plan
    // (e.g. a full disk or permissions problem) is diagnosable.
    if (process.env["OXAGEN_DEBUG"])
      process.stderr.write(
        `[fleet-store] write failed (${path}): ${err instanceof Error ? err.message : String(err)}\n`,
      );
  }
}

export interface PlanStore {
  save(plan: Plan): void;
  get(planId: string): Plan | undefined;
  list(): Plan[];
  /** Replace one task inside its plan and persist. */
  updateTask(planId: string, task: Task): void;
  /** Set a plan's lifecycle status and persist. */
  setStatus(planId: string, status: Plan["status"]): void;
}

/** Open the plan store for a working directory. */
export function openPlanStore(cwd: string): PlanStore {
  return {
    save(plan) {
      const data = read(cwd);
      const idx = data.plans.findIndex((p) => p.id === plan.id);
      if (idx >= 0) data.plans[idx] = plan;
      else data.plans.unshift(plan);
      // Keep the file bounded — the 50 most recent plans is plenty of history.
      data.plans = data.plans.slice(0, 50);
      write(cwd, data);
    },
    get(planId) {
      return read(cwd).plans.find((p) => p.id === planId);
    },
    list() {
      return read(cwd).plans;
    },
    updateTask(planId, task) {
      const data = read(cwd);
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) return;
      const idx = plan.tasks.findIndex((t) => t.id === task.id);
      if (idx >= 0) plan.tasks[idx] = task;
      write(cwd, data);
    },
    setStatus(planId, status) {
      const data = read(cwd);
      const plan = data.plans.find((p) => p.id === planId);
      if (!plan) return;
      plan.status = status;
      write(cwd, data);
    },
  };
}
