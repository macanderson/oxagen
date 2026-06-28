/**
 * The fleet orchestrator — an army of coding subagents working one tree at once.
 *
 * Each task is run by a subagent: the coding loop on the cheapest sufficient
 * model. The orchestrator keeps as many running as the concurrency cap allows
 * while respecting two safety rules so parallel agents never corrupt the tree
 * or each other:
 *
 *   1. Dependencies — a task waits until every task it `dependsOn` is `done`; if a
 *      dependency fails, the task (and its dependents) are marked `blocked`.
 *   2. File ownership — two tasks whose predicted `files` overlap are serialized,
 *      so two agents never edit the same file at the same time.
 *
 * It records a memory entry for every task it finishes (success or failure),
 * accumulates token/cost totals, and emits a snapshot on every change for the
 * agents screen to render.
 *
 * Unlike the CLI version, `AgentRunner` and `MemoryProvider` are always injected
 * (no defaults) — the engine does not know how to construct a local workspace or
 * connect to the gateway directly. The caller (CLI or platform) wires these in.
 */
import { EventEmitter } from "node:events";
import { enhancePrompt } from "../evaluate/prompt-enhancer.js";
import { accumulateUsage, routeModel } from "../router/model-router.js";
import { emptyUsage } from "../types.js";
import type { CodeGraphProvider } from "../types.js";
import type { MemoryProvider } from "../ports.js";
import type {
  AgentDefinition,
  AgentSnapshot,
  FleetSnapshot,
  Plan,
  Task,
} from "./types.js";
import type { ProjectContext } from "../types.js";

export * from "./types.js";

/** The subset of the coding loop the fleet depends on (injectable for tests). */
export type AgentRunner = (opts: {
  prompt: string;
  cwd: string;
  model?: string;
  projectContext?: ProjectContext;
  agent?: AgentDefinition;
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
  /** The agent runner — required; no default to keep the engine dep-light. */
  runner: AgentRunner;
  /** Max subagents running at once (default 4). */
  concurrency?: number;
  /** Memory provider for recording task outcomes. Optional. */
  memory?: MemoryProvider | null;
  /** Code graph provider for prompt enhancement. Optional. */
  codeGraph?: CodeGraphProvider | null;
  projectContext?: ProjectContext;
  /** Named agent registry; a task's `agent` is looked up here at dispatch. */
  agents?: Map<string, AgentDefinition>;
  /** Read-only subagents (explain, don't edit). */
  readOnly?: boolean;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "blocked"]);

export class Fleet extends EventEmitter {
  private readonly cwd: string;
  private readonly concurrency: number;
  private readonly memory: MemoryProvider | null;
  private readonly codeGraph: CodeGraphProvider | null;
  private readonly projectContext: ProjectContext | undefined;
  private readonly agents: Map<string, AgentDefinition>;
  private readonly runner: AgentRunner;
  private readonly readOnly: boolean;

  private readonly tasks = new Map<string, Task>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private adhocCounter = 0;

  private settle: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;

  constructor(opts: FleetOptions) {
    super();
    this.cwd = opts.cwd;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.memory = opts.memory ?? null;
    this.codeGraph = opts.codeGraph ?? null;
    this.projectContext = opts.projectContext;
    this.agents = opts.agents ?? new Map<string, AgentDefinition>();
    this.runner = opts.runner;
    this.readOnly = opts.readOnly ?? false;
  }

  /** Register every task in a plan (does not start it). */
  loadPlan(plan: Plan): void {
    for (const task of plan.tasks) {
      this.tasks.set(task.id, task);
      this.snapshots.set(task.id, this.toSnapshot(task, ""));
    }
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
      if (task.files.some((f) => lockedFiles.has(f))) continue;
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
      // Enhance the task with code-graph context + recalled lessons right before it runs.
      const enhanced = await enhancePrompt({
        prompt: task.description,
        codeGraph: this.codeGraph,
        memory: this.memory,
      });

      const result = await this.runner({
        prompt: enhanced.prompt,
        cwd: this.cwd,
        model: task.model,
        projectContext: this.projectContext,
        agent: task.agent ? this.agents.get(task.agent) : undefined,
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

      const aborted = "cancelled" === this.tasks.get(task.id)?.status;
      this.update(task.id, {
        status: aborted ? "cancelled" : "done",
        finishedAt: Date.now(),
        summary,
        usage,
        steps: result.steps,
        logTail: log,
      });
      this.recordSuccess(task, summary);
    } catch (err) {
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
    this.memory?.remember(
      isFix ? "bug-root-cause" : "routine-change",
      { lesson: summary || task.title, files: task.files, taskId: task.id },
      "success",
    );
  }

  private recordFailure(task: Task, error: string): void {
    this.memory?.remember(
      "gotcha",
      { lesson: `Task "${task.title}" failed: ${error}`, files: task.files, taskId: task.id },
      "failure",
    );
  }

  // ── State plumbing ───────────────────────────────────────────────────────────

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
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) task.finishedAt = patch.finishedAt;
    if (patch.summary !== undefined) task.summary = patch.summary;
    if (patch.error !== undefined) task.error = patch.error;
    if (patch.usage !== undefined) task.usage = patch.usage;

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
      const settle = this.settle;
      this.settle = null;
      settle();
    }
  }
}
