/**
 * The fleet orchestrator — an army of coding subagents working one tree at once.
 *
 * Each task is run by a subagent: the local coding loop ({@link runAgent}) on the
 * cheapest sufficient model, against the same working directory. The orchestrator
 * keeps as many running as the concurrency cap allows while respecting two safety
 * rules so parallel agents never corrupt the tree or each other:
 *
 *   1. Dependencies — a task waits until every task it `dependsOn` is `done`; if a
 *      dependency fails, the task (and its dependents) are marked `blocked`.
 *   2. File ownership — two tasks whose predicted `files` overlap are serialized,
 *      so two agents never edit the same file at the same time.
 *
 * It records a weighted memory for every task it finishes (success or failure),
 * accumulates token/cost totals, and emits a snapshot on every change for the
 * agents screen to render. `runAgent` is injected so the engine is unit-testable
 * without touching the gateway.
 */
import { EventEmitter } from "node:events";
import { runAgent } from "../loop.js";
import { enhancePrompt } from "../prompt-enhancer.js";
import { accumulateUsage, routeModel } from "../model-router.js";
import type { ProjectContext } from "../project-context.js";
import type { FleetMemory } from "./memory.js";
import type { PlanStore } from "./store.js";
import {
  emptyUsage,
  type AgentSnapshot,
  type FleetSnapshot,
  type Plan,
  type Task,
} from "./types.js";

/** The subset of {@link runAgent} the fleet depends on (injectable for tests). */
export type AgentRunner = (opts: {
  prompt: string;
  cwd: string;
  model?: string;
  projectContext?: ProjectContext;
  readOnly?: boolean;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onToolCall?: (name: string, input: unknown) => void;
}) => Promise<{
  text: string;
  steps: number;
  usage: { inputTokens?: number; outputTokens?: number };
}>;

export interface FleetOptions {
  cwd: string;
  /** Max subagents running at once (default 4). */
  concurrency?: number;
  memory?: FleetMemory | null;
  store?: PlanStore | null;
  projectContext?: ProjectContext;
  /** Inject a fake runner in tests; defaults to the real {@link runAgent}. */
  runner?: AgentRunner;
  /** Read-only subagents (explain, don't edit). */
  readOnly?: boolean;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "blocked"]);

export class Fleet extends EventEmitter {
  private readonly cwd: string;
  private readonly concurrency: number;
  private readonly memory: FleetMemory | null;
  private readonly store: PlanStore | null;
  private readonly projectContext: ProjectContext | undefined;
  private readonly runner: AgentRunner;
  private readonly readOnly: boolean;

  private readonly tasks = new Map<string, Task>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private planId: string | null = null;

  private settle: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private adhocCounter = 0;

  constructor(opts: FleetOptions) {
    super();
    this.cwd = opts.cwd;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.memory = opts.memory ?? null;
    this.store = opts.store ?? null;
    this.projectContext = opts.projectContext;
    this.runner = opts.runner ?? runAgent;
    this.readOnly = opts.readOnly ?? false;
  }

  /** Register every task in a plan (does not start it). */
  loadPlan(plan: Plan): void {
    this.planId = plan.id;
    for (const task of plan.tasks) {
      this.tasks.set(task.id, task);
      this.snapshots.set(task.id, this.toSnapshot(task, ""));
    }
    this.store?.setStatus(plan.id, "executing");
    this.emitUpdate();
  }

  /** Add one ad-hoc task (e.g. typed into the agents screen). Returns its id. */
  dispatchPrompt(prompt: string): string {
    const id = `adhoc-${++this.adhocCounter}`;
    const decision = routeModel({ text: prompt });
    const task: Task = {
      id,
      title: prompt.length > 64 ? prompt.slice(0, 61) + "…" : prompt,
      description: prompt,
      status: "queued",
      dependsOn: [],
      files: [],
      tier: decision.tier,
      model: decision.model,
      createdAt: Date.now(),
      usage: emptyUsage(),
    };
    this.tasks.set(id, task);
    this.snapshots.set(id, this.toSnapshot(task, ""));
    this.emitUpdate();
    this.pump();
    return id;
  }

  /** Begin scheduling. Resolves when every task has reached a terminal state. */
  start(): Promise<void> {
    if (!this.donePromise) {
      this.donePromise = new Promise<void>((resolve) => {
        this.settle = resolve;
      });
    }
    this.pump();
    this.checkDone();
    return this.donePromise;
  }

  /** Cancel one running/queued task. */
  cancelTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task || TERMINAL.has(task.status)) return;
    this.controllers.get(id)?.abort();
    this.controllers.delete(id);
    this.running.delete(id);
    this.update(id, { status: "cancelled", finishedAt: Date.now() });
    this.pump();
    this.checkDone();
  }

  /** Cancel everything in flight. */
  cancelAll(): void {
    for (const id of [...this.tasks.keys()]) {
      const t = this.tasks.get(id);
      if (t && !TERMINAL.has(t.status)) this.cancelTask(id);
    }
  }

  snapshot(): FleetSnapshot {
    const agents = [...this.snapshots.values()];
    const totals = agents.reduce(
      (acc, a) => ({
        inputTokens: acc.inputTokens + a.usage.inputTokens,
        outputTokens: acc.outputTokens + a.usage.outputTokens,
        costUsd: acc.costUsd + a.usage.costUsd,
      }),
      emptyUsage(),
    );
    return {
      agents,
      queuedCount: agents.filter((a) => a.status === "queued").length,
      runningCount: agents.filter((a) => a.status === "running").length,
      doneCount: agents.filter((a) => a.status === "done").length,
      failedCount: agents.filter((a) => a.status === "failed" || a.status === "blocked").length,
      totals,
      concurrency: this.concurrency,
    };
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  /** Fill open slots with ready tasks, honouring deps and file-ownership locks. */
  private pump(): void {
    // First, mark tasks whose dependencies can never succeed as blocked.
    for (const task of this.tasks.values()) {
      if (task.status !== "queued") continue;
      const deps = task.dependsOn.map((d) => this.tasks.get(d));
      if (deps.some((d) => d && (d.status === "failed" || d.status === "blocked" || d.status === "cancelled"))) {
        this.update(task.id, { status: "blocked" });
      }
    }

    while (this.running.size < this.concurrency) {
      const next = this.pickReady();
      if (!next) break;
      void this.run(next);
    }
  }

  /** The next queued task whose deps are all done and whose files are free. */
  private pickReady(): Task | undefined {
    const lockedFiles = new Set<string>();
    for (const id of this.running) {
      for (const f of this.tasks.get(id)?.files ?? []) lockedFiles.add(f);
    }
    for (const task of this.tasks.values()) {
      if (task.status !== "queued") continue;
      const depsDone = task.dependsOn.every((d) => this.tasks.get(d)?.status === "done");
      if (!depsDone) continue;
      if (task.files.some((f) => lockedFiles.has(f))) continue; // would collide with a running agent
      return task;
    }
    return undefined;
  }

  private async run(task: Task): Promise<void> {
    this.running.add(task.id);
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    this.update(task.id, { status: "running", startedAt: Date.now() });

    let log = "";
    let steps = 0;
    const appendLog = (s: string): void => {
      log = (log + s).slice(-2000);
    };

    try {
      // Enhance the task with code-graph context + lessons right before it runs.
      const enhanced = await enhancePrompt({
        prompt: task.description,
        cwd: this.cwd,
        memory: this.memory,
      });

      const result = await this.runner({
        prompt: enhanced.prompt,
        cwd: this.cwd,
        model: task.model,
        projectContext: this.projectContext,
        readOnly: this.readOnly,
        signal: controller.signal,
        onText: (delta) => {
          appendLog(delta);
          this.update(task.id, { logTail: log });
        },
        onToolCall: (name) => {
          steps++;
          this.update(task.id, { lastTool: name, steps });
        },
      });

      const usage = accumulateUsage(emptyUsage(), task.model, result.usage);
      const summary = result.text.trim().slice(0, 280);
      this.update(task.id, {
        status: "cancelled" === this.tasks.get(task.id)?.status ? "cancelled" : "done",
        finishedAt: Date.now(),
        summary,
        usage,
        steps: result.steps,
        logTail: log,
      });
      this.recordSuccess(task, summary);
    } catch (err) {
      // An aborted run surfaces as cancelled, not failed.
      if (controller.signal.aborted) {
        this.update(task.id, { status: "cancelled", finishedAt: Date.now() });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.update(task.id, { status: "failed", finishedAt: Date.now(), error: message });
        this.recordFailure(task, message);
      }
    } finally {
      this.running.delete(task.id);
      this.controllers.delete(task.id);
      this.pump();
      this.checkDone();
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  private recordSuccess(task: Task, summary: string): void {
    const isFix = /\b(fix|bug|broken|regression|repair|error)\b/i.test(task.title + " " + task.description);
    this.memory?.record({
      kind: isFix ? "bug-root-cause" : "routine-change",
      weight: task.tier === "precise" ? "high" : "low",
      lesson: summary || task.title,
      files: task.files,
      taskId: task.id,
      outcome: "success",
    });
  }

  private recordFailure(task: Task, error: string): void {
    this.memory?.record({
      kind: "gotcha",
      weight: "high",
      lesson: `Task "${task.title}" failed: ${error}`,
      files: task.files,
      taskId: task.id,
      outcome: "failure",
    });
  }

  // ── State plumbing ────────────────────────────────────────────────────────────

  private toSnapshot(task: Task, logTail: string): AgentSnapshot {
    return {
      taskId: task.id,
      title: task.title,
      tier: task.tier,
      model: task.model,
      status: task.status,
      steps: 0,
      usage: task.usage,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      logTail,
      error: task.error,
    };
  }

  private update(id: string, patch: Partial<Task> & Partial<AgentSnapshot>): void {
    const task = this.tasks.get(id);
    if (!task) return;
    // Apply task-level fields.
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) task.finishedAt = patch.finishedAt;
    if (patch.summary !== undefined) task.summary = patch.summary;
    if (patch.error !== undefined) task.error = patch.error;
    if (patch.usage !== undefined) task.usage = patch.usage;
    this.store?.updateTask(this.planId ?? "", task);

    const prev = this.snapshots.get(id);
    const snap: AgentSnapshot = {
      ...(prev ?? this.toSnapshot(task, "")),
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      usage: task.usage,
      error: task.error,
    };
    if (patch.steps !== undefined) snap.steps = patch.steps;
    if (patch.lastTool !== undefined) snap.lastTool = patch.lastTool;
    if (patch.logTail !== undefined) snap.logTail = patch.logTail;
    this.snapshots.set(id, snap);
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.emit("update", this.snapshot());
  }

  private checkDone(): void {
    if (!this.settle) return;
    const allTerminal = [...this.tasks.values()].every((t) => TERMINAL.has(t.status));
    if (allTerminal && this.tasks.size > 0) {
      if (this.planId && this.store) {
        const anyFailed = [...this.tasks.values()].some((t) => t.status === "failed");
        this.store.setStatus(this.planId, anyFailed ? "failed" : "completed");
      }
      const settle = this.settle;
      this.settle = null;
      settle();
    }
  }
}
