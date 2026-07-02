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
 * It records a two-axis memory for every task it finishes (success or failure),
 * accumulates token/cost totals, and emits a snapshot on every change for the
 * agents screen to render. `runAgent` is injected so the engine is unit-testable
 * without touching the gateway.
 */
import { EventEmitter } from "node:events";
import type { MemoryProvider } from "@oxagen/agent-engine";
import { runAgent } from "../loop.js";
import {
  createCombinedMemory,
  type ServerMemory,
} from "../adapters/memory-provider.js";
import { enhancePrompt } from "../prompt-enhancer.js";
import { accumulateUsage, routeModel } from "../model-router.js";
import type { ProjectContext } from "../project-context.js";
import type { AgentDefinition } from "../../agents/types.js";
import type { FleetMemory } from "./memory.js";
import type { PlanStore } from "./store.js";
import type { Isolation, IntegrationResult } from "./git-isolation.js";
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
  agent?: AgentDefinition;
  readOnly?: boolean;
  signal?: AbortSignal;
  memory?: MemoryProvider | null;
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
  /**
   * Platform memory handle shared across all tasks. When present (CLI is
   * authenticated), each subagent recalls the workspace's prior-session lessons
   * before it acts, and every finished task's lesson is mirrored back. Null
   * degrades the fleet to local-only exactly as before.
   */
  serverMemory?: ServerMemory | null;
  store?: PlanStore | null;
  projectContext?: ProjectContext;
  /** Named agent registry; a task's `agent` is looked up here at dispatch. */
  agents?: Map<string, AgentDefinition>;
  /** Inject a fake runner in tests; defaults to the real {@link runAgent}. */
  runner?: AgentRunner;
  /** Read-only subagents (explain, don't edit). */
  readOnly?: boolean;
  /**
   * Per-task git isolation. When set, each agent runs in its own worktree and
   * its work is checkpointed + integrated via explicit merges, so parallel
   * agents physically cannot clobber the tree. When omitted (default), all
   * agents share `cwd` and overlapping-file tasks are serialized instead.
   */
  isolation?: Isolation | null;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "blocked"]);

export class Fleet extends EventEmitter {
  private readonly cwd: string;
  private readonly concurrency: number;
  private readonly memory: FleetMemory | null;
  private readonly serverMemory: ServerMemory | null;
  private readonly store: PlanStore | null;
  private readonly projectContext: ProjectContext | undefined;
  private readonly agents: Map<string, AgentDefinition>;
  private readonly runner: AgentRunner;
  private readonly readOnly: boolean;
  private readonly isolation: Isolation | null;

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
    this.serverMemory = opts.serverMemory ?? null;
    this.store = opts.store ?? null;
    this.projectContext = opts.projectContext;
    this.agents = opts.agents ?? new Map<string, AgentDefinition>();
    this.runner = opts.runner ?? runAgent;
    this.readOnly = opts.readOnly ?? false;
    this.isolation = opts.isolation ?? null;
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
      // With isolation, overlapping files are safe (each agent has its own
      // worktree; collisions become merge conflicts, surfaced at integration).
      // Without it, serialize tasks that would fight over the same file.
      if (!this.isolation && task.files.some((f) => lockedFiles.has(f))) continue;
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

    // With isolation on, the agent works in its own worktree, not the shared
    // tree. Conflicts (if any) are surfaced after it finishes, not silently.
    let workdir = this.cwd;
    let conflict: IntegrationResult | null = null;
    try {
      if (this.isolation && !this.readOnly) {
        workdir = await this.isolation.spawn(task.id);
      }

      // Enhance the task with code-graph context + lessons right before it runs.
      const enhanced = await enhancePrompt({
        prompt: task.description,
        cwd: this.cwd,
        memory: this.memory,
      });

      // Per-task recall of the workspace's prior-session lessons (best-effort,
      // timeout-guarded inside the combined provider). The server handle is
      // shared across tasks; the recall query is this task's description. No
      // local session/fleet store is threaded here — the fleet records its own
      // two-axis lesson after the task in recordSuccess/recordFailure.
      const taskMemory: MemoryProvider | null = this.serverMemory
        ? createCombinedMemory(null, null, {
            server: this.serverMemory,
            recallQuery: task.description,
          })
        : null;

      const result = await this.runner({
        prompt: enhanced.prompt,
        cwd: workdir,
        model: task.model,
        projectContext: this.projectContext,
        agent: task.agent ? this.agents.get(task.agent) : undefined,
        readOnly: this.readOnly,
        signal: controller.signal,
        memory: taskMemory,
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
      let summary = result.text.trim().slice(0, 280);

      // Commit the agent's work atomically (pinned, so it can never be lost),
      // then merge it back. A conflict is surfaced — never a corrupt tree.
      if (this.isolation && !this.readOnly && !controller.signal.aborted) {
        await this.isolation.checkpoint(task.id, `fleet(${task.id}): ${task.title}`);
        conflict = await this.isolation.integrate(task.id, `fleet(${task.id}): ${task.title}`);
        if (!conflict.ok) {
          const files = (conflict.conflicts ?? []).join(", ");
          summary = `⚠ integration conflict in ${conflict.conflicts?.length ?? 0} file(s): ${files}`.slice(0, 280);
          this.emit("conflict", { taskId: task.id, ...conflict });
        }
      }

      const aborted = "cancelled" === this.tasks.get(task.id)?.status;
      this.update(task.id, {
        status: aborted ? "cancelled" : "done",
        finishedAt: Date.now(),
        summary,
        usage,
        steps: result.steps,
        logTail: log,
        ...(conflict && !conflict.ok ? { error: summary } : {}),
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
      // Tear down the worktree — but keep it on a conflict so a resolver agent
      // or human can finish the merge in place. The pinned commits survive
      // either way, so the agent's work is never lost.
      if (this.isolation && !this.readOnly) {
        await this.isolation.dispose(task.id, { keep: conflict ? !conflict.ok : false });
      }
      this.running.delete(task.id);
      this.controllers.delete(task.id);
      this.pump();
      this.checkDone();
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  private recordSuccess(task: Task, summary: string): void {
    const isFix = /\b(fix|bug|broken|regression|repair|error)\b/i.test(task.title + " " + task.description);
    const kind = isFix ? "bug-root-cause" : "routine-change";
    const lesson = summary || task.title;
    this.memory?.record({
      memoryKind: kind,
      memoryClass: task.tier === "precise" ? "RULE" : "OBSERVATION",
      enforcementScore: task.tier === "precise" ? 70 : null,
      lesson,
      files: task.files,
      taskId: task.id,
      outcome: "success",
    });
    // Mirror the lesson to the platform so other sessions recall it (fire-and-
    // forget; the handle swallows its own errors).
    this.serverMemory?.remember(kind, { lesson, files: task.files });
  }

  private recordFailure(task: Task, error: string): void {
    const lesson = `Task "${task.title}" failed: ${error}`;
    this.memory?.record({
      memoryKind: "gotcha",
      memoryClass: "RULE",
      enforcementScore: 70,
      lesson,
      files: task.files,
      taskId: task.id,
      outcome: "failure",
    });
    this.serverMemory?.remember("gotcha", { lesson, files: task.files });
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
