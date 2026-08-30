/**
 * The fleet orchestrator — an army of coding subagents working one tree at once.
 *
 * Each task is run by a subagent: the ONE engine loop ({@link runTurn} via the
 * injected {@link AgentRunner}) on the cheapest sufficient model, against the same
 * working directory. The orchestrator keeps as many running as the concurrency cap
 * allows while respecting two safety rules so parallel agents never corrupt the
 * tree or each other:
 *
 *   1. Dependencies — a task waits until every task it `dependsOn` is `done`; if a
 *      dependency fails, the task (and its dependents) are marked `blocked`.
 *   2. File ownership — two tasks whose predicted `files` overlap are serialized,
 *      so two agents never edit the same file at the same time.
 *
 * It records a two-axis memory for every task it finishes (success or failure),
 * accumulates token/cost totals, and emits a snapshot on every change for the
 * agents screen to render. The runner is injected so the engine is unit-testable
 * without touching the gateway.
 */
import { EventEmitter } from "node:events";
import type { MemoryProvider, FileLockProvider } from "@oxagen/agent-engine";
import { debugLog } from "../../lib/debug-log.js";
import { createEngineRunner } from "../engine-runner.js";
import { createLocalFileLockProvider } from "./local-file-lock.js";
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
  type ModelTier,
  type Plan,
  type Task,
  type TaskStatus,
  type UsageTotals,
} from "./types.js";

// The runner port lives in agent-runner.ts (a leaf) so its implementation
// (engine-runner.ts) can type-depend on it without importing this orchestrator
// back — this module value-imports createEngineRunner as the default runner.
// Re-exported so existing consumers keep their import path.
import type { AgentRunner } from "./agent-runner.js";
export type { AgentRunner } from "./agent-runner.js";

/**
 * A discrete lifecycle transition for one task — emitted (as the "task" event)
 * every time a task's status changes, alongside the existing whole-fleet
 * "update" snapshot. Consumers that want per-task events instead of diffing
 * consecutive snapshots (e.g. the headless JSONL runner) listen to this
 * instead; the TUI still drives off "update".
 */
export interface FleetTaskEvent {
  taskId: string;
  status: TaskStatus;
  title: string;
  tier: ModelTier;
  model: string;
  agent?: string;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  error?: string;
  usage: UsageTotals;
}

export interface FleetOptions {
  cwd: string;
  /** Max subagents running at once (default 4). Also the ceiling any {@link concurrencyProvider} clamps under. */
  concurrency?: number;
  /**
   * Dynamic concurrency cap consulted on every slot refill (ADR-030 §resource).
   * Lets a resource monitor scale the fleet down under machine pressure and back
   * up when it eases — WITHOUT restarting the fleet. Its value is clamped to
   * `[1, concurrency]`: a provider can never push above the configured ceiling,
   * and never below 1. Omitted ⇒ the fixed `concurrency` (steady behaviour).
   * Lowering it mid-run stops NEW dispatches; already-running tasks finish.
   */
  concurrencyProvider?: () => number;
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
  /** Inject a fake runner in tests; defaults to the real {@link createEngineRunner} result. */
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
  /**
   * File-lock provider shared across tasks (ADR-021 §5). When omitted, a
   * {@link createLocalFileLockProvider} rooted at `cwd` is used for shared-tree
   * fleets so every task dynamically locks the files it actually writes —
   * fixing ad-hoc tasks (which declare no predicted `files`) racing on the same
   * file. With `isolation` on, locking is skipped: each agent has its own
   * worktree, so collisions surface as merge conflicts, not corruption. Pass
   * `null` to force-disable.
   */
  fileLock?: FileLockProvider | null;
}

const TERMINAL = new Set(["done", "failed", "cancelled", "blocked"]);

export class Fleet extends EventEmitter {
  private readonly cwd: string;
  private readonly concurrency: number;
  private readonly concurrencyProvider: () => number;
  private readonly memory: FleetMemory | null;
  private readonly serverMemory: ServerMemory | null;
  private readonly store: PlanStore | null;
  private readonly projectContext: ProjectContext | undefined;
  private readonly agents: Map<string, AgentDefinition>;
  private readonly runner: AgentRunner;
  private readonly readOnly: boolean;
  private readonly isolation: Isolation | null;
  private readonly fileLock: FileLockProvider | null;

  private readonly tasks = new Map<string, Task>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private planId: string | null = null;
  /** Set by {@link drain}: stop dispatching new tasks, let in-flight ones finish. */
  private draining = false;

  private settle: (() => void) | null = null;
  private donePromise: Promise<void> | null = null;
  private adhocCounter = 0;

  constructor(opts: FleetOptions) {
    super();
    this.cwd = opts.cwd;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.concurrencyProvider =
      opts.concurrencyProvider ?? (() => this.concurrency);
    this.memory = opts.memory ?? null;
    this.serverMemory = opts.serverMemory ?? null;
    this.store = opts.store ?? null;
    this.projectContext = opts.projectContext;
    this.agents = opts.agents ?? new Map<string, AgentDefinition>();
    this.runner = opts.runner ?? createEngineRunner();
    this.readOnly = opts.readOnly ?? false;
    this.isolation = opts.isolation ?? null;
    // Shared-tree fleets get a local file lock so undeclared-overlap tasks
    // (esp. ad-hoc prompts with no predicted `files`) can't clobber the same
    // file. Isolation makes it unnecessary — each agent has its own worktree.
    this.fileLock =
      opts.fileLock !== undefined
        ? opts.fileLock
        : this.isolation
          ? null
          : createLocalFileLockProvider({ root: this.cwd });
  }

  /** Register every task in a plan (does not start it). */
  loadPlan(plan: Plan): void {
    this.planId = plan.id;
    for (const task of plan.tasks) {
      this.tasks.set(task.id, task);
      this.snapshots.set(task.id, this.toSnapshot(task, ""));
      this.emitTask(task);
    }
    this.store?.setStatus(plan.id, "executing");
    this.emitUpdate();
  }

  /**
   * Add one ad-hoc task (e.g. typed into the agents screen). Returns its id.
   *
   * While {@link drain}ing the task is born `cancelled`, not `queued`: pump()
   * dispatches nothing once draining, so a queued task would never reach a
   * terminal state and `drain()`/`start()`'s promise would never settle —
   * wedging the caller (the agents screen waits on it to exit) forever.
   */
  dispatchPrompt(prompt: string): string {
    const id = `adhoc-${++this.adhocCounter}`;
    const decision = routeModel({ text: prompt });
    const now = Date.now();
    const task: Task = {
      id,
      title: prompt.length > 64 ? prompt.slice(0, 61) + "…" : prompt,
      description: prompt,
      status: this.draining ? "cancelled" : "queued",
      ...(this.draining ? { finishedAt: now } : {}),
      dependsOn: [],
      files: [],
      tier: decision.tier,
      model: decision.model,
      createdAt: now,
      usage: emptyUsage(),
    };
    this.tasks.set(id, task);
    this.snapshots.set(id, this.toSnapshot(task, ""));
    this.emitTask(task);
    this.emitUpdate();
    this.pump();
    this.checkDone();
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

  /**
   * Cancel-drain: stop dispatching new tasks, but let every already-running
   * task finish on its own — its worktree is then checkpointed, integrated,
   * and disposed through the normal completion path in {@link run}'s
   * `finally`, instead of being torn down mid-edit. Unlike {@link cancelAll},
   * running agents' controllers are never aborted, so no worktree is ever
   * orphaned. Tasks that never started have no worktree to lose, so they're
   * cancelled immediately. Resolves once every task has reached a terminal
   * state — the same contract as {@link start}.
   */
  drain(): Promise<void> {
    this.draining = true;
    for (const task of this.tasks.values()) {
      if (task.status === "queued")
        this.update(task.id, { status: "cancelled", finishedAt: Date.now() });
    }
    if (this.tasks.size === 0) return Promise.resolve(); // nothing was ever loaded
    if (!this.donePromise) {
      this.donePromise = new Promise<void>((resolve) => {
        this.settle = resolve;
      });
    }
    this.checkDone();
    return this.donePromise;
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
      failedCount: agents.filter(
        (a) => a.status === "failed" || a.status === "blocked",
      ).length,
      totals,
      concurrency: this.concurrency,
    };
  }

  // ── Scheduling ──────────────────────────────────────────────────────────────

  /** Fill open slots with ready tasks, honouring deps and file-ownership locks. */
  private pump(): void {
    // First, mark tasks whose dependencies can never succeed as blocked —
    // iterate to a fixed point so a multi-level cascade (A fails → B blocked
    // → C, which depends on B, is also blocked) fully resolves in this one
    // pump(), regardless of task insertion order. Bounded and terminating:
    // each round either blocks at least one more task or nothing changes.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) {
        if (task.status !== "queued") continue;
        const deps = task.dependsOn.map((d) => this.tasks.get(d));
        if (
          deps.some(
            (d) =>
              d &&
              (d.status === "failed" ||
                d.status === "blocked" ||
                d.status === "cancelled"),
          )
        ) {
          this.update(task.id, { status: "blocked" });
          changed = true;
        }
      }
    }

    // Cancel-drain: dispatching stops, but tasks already running are left
    // alone so they finish naturally (see drain()).
    if (this.draining) return;

    // The effective cap is consulted on every refill, so a resource monitor can
    // shrink or grow the fleet mid-run. Clamped to [1, concurrency]: a provider
    // never pushes past the configured ceiling, and a bad/NaN value degrades to
    // the fixed ceiling rather than wedging dispatch.
    while (this.running.size < this.currentConcurrency()) {
      const next = this.pickReady();
      if (!next) break;
      void this.run(next);
    }
  }

  /** The live cap: the provider's value, floored to an int and clamped to [1, concurrency]. */
  private currentConcurrency(): number {
    const raw = this.concurrencyProvider();
    const n = Number.isFinite(raw) ? Math.floor(raw) : this.concurrency;
    return Math.max(1, Math.min(this.concurrency, n));
  }

  /**
   * Run {@link pump} + {@link checkDone} such that a throw in either can NEVER
   * wedge slot refilling. The scheduler is re-driven from every task's
   * completion; if one such re-drive threw unguarded it would strand the fleet
   * with a freed slot but nothing dispatched into it. Errors are reported
   * through the "scheduler-error" channel and swallowed here so the loop lives.
   */
  private pumpSafely(): void {
    try {
      this.pump();
    } catch (err) {
      this.reportSchedulerError("pump", err);
    }
    try {
      this.checkDone();
    } catch (err) {
      this.reportSchedulerError("checkDone", err);
    }
  }

  /** Surface a scheduler-internal error without crashing the runtime. */
  private reportSchedulerError(phase: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    // A dedicated, non-"error" event name: an unhandled "error" on an
    // EventEmitter with no listener THROWS, which is exactly the wedge we're
    // guarding against — so this channel is safe even with zero subscribers.
    this.emit("scheduler-error", { phase, message });
    void debugLog("error", "fleet.scheduler-error", { phase, message });
  }

  /** The next queued task whose deps are all done and whose files are free. */
  private pickReady(): Task | undefined {
    const lockedFiles = new Set<string>();
    for (const id of this.running) {
      for (const f of this.tasks.get(id)?.files ?? []) lockedFiles.add(f);
    }
    for (const task of this.tasks.values()) {
      if (task.status !== "queued") continue;
      const depsDone = task.dependsOn.every(
        (d) => this.tasks.get(d)?.status === "done",
      );
      if (!depsDone) continue;
      // With isolation, overlapping files are safe (each agent has its own
      // worktree; collisions become merge conflicts, surfaced at integration).
      // Without it, serialize tasks that would fight over the same file.
      if (!this.isolation && task.files.some((f) => lockedFiles.has(f)))
        continue;
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
        // File lock (ADR-021 §5): runTurn mints a unique per-turn holder, so
        // two tasks writing the same file see each other as conflicting holders
        // and the engine serializes their writes (or surfaces a "Blocked" tool
        // result) instead of clobbering.
        fileLock: this.fileLock,
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
        await this.isolation.checkpoint(
          task.id,
          `fleet(${task.id}): ${task.title}`,
        );
        conflict = await this.isolation.integrate(
          task.id,
          `fleet(${task.id}): ${task.title}`,
        );
        if (!conflict.ok) {
          const files = (conflict.conflicts ?? []).join(", ");
          summary =
            `⚠ integration conflict in ${conflict.conflicts?.length ?? 0} file(s): ${files}`.slice(
              0,
              280,
            );
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
        this.update(task.id, {
          status: "failed",
          finishedAt: Date.now(),
          error: message,
        });
        this.recordFailure(task, message);
      }
    } finally {
      // Tear down the worktree — but keep it on a conflict so a resolver agent
      // or human can finish the merge in place. The pinned commits survive
      // either way, so the agent's work is never lost. A dispose() throw MUST
      // NOT skip the slot cleanup below (it runs first in this finally): if it
      // did, `running` would never release this task's slot and the fleet would
      // wedge with a phantom occupant. So it is caught and reported, never
      // rethrown.
      if (this.isolation && !this.readOnly) {
        try {
          await this.isolation.dispose(task.id, {
            keep: conflict ? !conflict.ok : false,
          });
        } catch (err) {
          this.reportSchedulerError("dispose", err);
        }
      }
      this.running.delete(task.id);
      this.controllers.delete(task.id);
      // Guarded: a throw here must never strand the freed slot (see pumpSafely).
      this.pumpSafely();
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  private recordSuccess(task: Task, summary: string): void {
    const isFix = /\b(fix|bug|broken|regression|repair|error)\b/i.test(
      task.title + " " + task.description,
    );
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

  private update(
    id: string,
    patch: Partial<Task> & Partial<AgentSnapshot>,
  ): void {
    const task = this.tasks.get(id);
    if (!task) return;
    const statusChanged =
      patch.status !== undefined && patch.status !== task.status;
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
    if (statusChanged) this.emitTask(task);
    this.emitUpdate();
  }

  private emitUpdate(): void {
    this.emit("update", this.snapshot());
  }

  /** Emit a discrete {@link FleetTaskEvent} for `task`'s current status. */
  private emitTask(task: Task): void {
    const event: FleetTaskEvent = {
      taskId: task.id,
      status: task.status,
      title: task.title,
      tier: task.tier,
      model: task.model,
      agent: task.agent,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      summary: task.summary,
      error: task.error,
      usage: task.usage,
    };
    this.emit("task", event);
  }

  private checkDone(): void {
    if (!this.settle) return;
    const allTerminal = [...this.tasks.values()].every((t) =>
      TERMINAL.has(t.status),
    );
    if (allTerminal && this.tasks.size > 0) {
      if (this.planId && this.store) {
        const anyFailed = [...this.tasks.values()].some(
          (t) => t.status === "failed",
        );
        // Persisting the final plan status must never block settling — a store
        // write failure is reported, not allowed to leave `start()`/`drain()`
        // hanging forever on an unresolved donePromise.
        try {
          this.store.setStatus(this.planId, anyFailed ? "failed" : "completed");
        } catch (err) {
          this.reportSchedulerError("store.setStatus", err);
        }
      }
      const settle = this.settle;
      this.settle = null;
      settle();
    }
  }
}
