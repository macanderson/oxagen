/**
 * Fleet execution for one REPL turn — the subagent fan-out path.
 *
 * When the per-turn planner (plan-turn.ts) produces more than one task, the
 * turn executes here instead of the single main loop: every task runs as its
 * own fleet subagent (the ONE engine loop on the cheapest sufficient model),
 * concurrently up to the cap, each in its own git worktree with its work merged
 * back — the same machinery `oxagen agents` uses, now reachable from the TUI.
 *
 * Task lifecycle and live snapshots are surfaced through callbacks so the REPL
 * can drive the Task Progress checklist, the Agent Team panel, and the
 * transcript in real time. Esc/Ctrl-C aborts propagate to every running
 * subagent via the turn signal.
 */
import { tierForSlug, type AgentAi } from "@oxagen/agent-engine";
import {
  Fleet,
  type FleetOptions,
  type FleetTaskEvent,
} from "../agent/fleet/orchestrator.js";
import {
  WorktreeManager,
  isGitRepo,
  type Isolation,
} from "../agent/fleet/git-isolation.js";
import { createEngineRunner } from "../agent/engine-runner.js";
import type { FleetMemory } from "../agent/fleet/memory.js";
import type { PlanStore } from "../agent/fleet/store.js";
import type { ServerMemory } from "../agent/adapters/memory-provider.js";
import type { ProjectContext } from "../agent/project-context.js";
import type { AgentDefinition } from "../agents/types.js";
import type { FleetSnapshot, Plan } from "../agent/fleet/types.js";

export interface FleetTurnOptions {
  plan: Plan;
  cwd: string;
  /**
   * AI port the subagents' model calls go through — the session's own port, so
   * platform-authenticated sessions fan out without local BYOK keys and usage
   * lands in the session metrics. Omitted → per-task BYOK gateway (fleet CLI
   * behaviour).
   */
  ai?: AgentAi;
  /**
   * Explicit worker-model pin (the REPL's `/worker-model` slug). The planner
   * normally assigns each task its own tier-appropriate model — but a pin is a
   * deliberate, explicit choice and must win unconditionally, exactly like it
   * does on the single-task path (`selectModel`'s override branch in the
   * engine pipeline). Undefined ⇒ every task keeps its planner-assigned model.
   */
  workerModel?: string;
  memory?: FleetMemory | null;
  serverMemory?: ServerMemory | null;
  /** Durable plan store; task status updates are persisted when present. */
  store?: PlanStore | null;
  projectContext?: ProjectContext;
  agents?: Map<string, AgentDefinition>;
  readOnly?: boolean;
  /** Max subagents in flight at once (Fleet default when omitted). */
  concurrency?: number;
  /**
   * Dynamic ceiling consulted at every slot refill (resource-aware swarm
   * sizing — see repl/resource-monitor.ts). Clamped to [1, concurrency] by
   * the orchestrator; omitted ⇒ the fixed `concurrency` cap.
   */
  concurrencyProvider?: () => number;
  /**
   * Fired with the live fleet's cancel surface right after construction —
   * lets the caller wire per-task kill affordances (the swarm panel / global
   * Ctrl-X route through agent-registry abort handles to `cancelTask`).
   */
  onFleet?: (fleet: {
    cancelTask: (id: string) => void;
    cancelAll: () => void;
  }) => void;
  /** Per-task git worktree isolation (default on inside a git repo). */
  isolate?: boolean;
  /** The turn signal — aborting cancels every queued and running task. */
  signal?: AbortSignal;
  /** Discrete task lifecycle transitions (status changes). */
  onTask?: (ev: FleetTaskEvent) => void;
  /** Whole-fleet snapshot on every change (steps, tools, usage). */
  onUpdate?: (snap: FleetSnapshot) => void;
  /** Test seam; defaults to the real {@link Fleet}. */
  fleetFactory?: (opts: FleetOptions) => Fleet;
  /** Test seam; defaults to {@link WorktreeManager} when `cwd` is a git repo. */
  isolationFactory?: () => Promise<Isolation | null>;
}

export interface FleetTurnResult {
  snapshot: FleetSnapshot;
  /** Human-readable per-task outcome block for the transcript + history. */
  summaryText: string;
  failedCount: number;
}

/** Status glyph for the end-of-fleet summary lines. */
function glyph(status: string): string {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "blocked":
      return "⊘";
    case "cancelled":
      return "◌";
    default:
      return "·";
  }
}

/** Build the transcript/history summary from the plan's terminal task states. */
export function summarizeFleetRun(plan: Plan, snapshot: FleetSnapshot): string {
  const byId = new Map(snapshot.agents.map((a) => [a.taskId, a]));
  const lines = plan.tasks.map((t) => {
    const snap = byId.get(t.id);
    const status = snap?.status ?? t.status;
    const note = (t.summary ?? snap?.error ?? "").replace(/\s+/g, " ").trim();
    return `${glyph(status)} ${t.title}${note ? ` — ${note.slice(0, 160)}` : ""}`;
  });
  const { totals } = snapshot;
  const cost = totals.costUsd > 0 ? ` · $${totals.costUsd.toFixed(4)}` : "";
  lines.push(
    `${snapshot.doneCount}/${plan.tasks.length} tasks done` +
      (snapshot.failedCount > 0 ? `, ${snapshot.failedCount} failed` : "") +
      ` · ${totals.inputTokens.toLocaleString()} in / ${totals.outputTokens.toLocaleString()} out tokens${cost}`,
  );
  return lines.join("\n");
}

/**
 * Execute a multi-task plan as a fleet of subagents and resolve once every
 * task reaches a terminal state. Never rejects for task failures — those are
 * reported in the result; only infrastructure setup can throw.
 */
export async function runFleetTurn(
  opts: FleetTurnOptions,
): Promise<FleetTurnResult> {
  const isolation = opts.isolationFactory
    ? await opts.isolationFactory()
    : opts.isolate !== false && !opts.readOnly && (await isGitRepo(opts.cwd))
      ? new WorktreeManager({
          repoRoot: opts.cwd,
          namespace: `repl-${Date.now()}`,
        })
      : null;

  // A worker-model pin wins over every task's planner-assigned tier/model —
  // otherwise `/worker-model <slug>` silently stops applying the moment a
  // prompt happens to decompose into more than one task, which is surprising:
  // the user pinned the executor, not "the executor, except when the REPL
  // quietly fans out to the fleet." Build a NEW plan rather than mutate the
  // caller's tasks in place (the REPL still owns that object for its Task
  // Progress checklist).
  const plan: Plan = opts.workerModel
    ? {
        ...opts.plan,
        tasks: opts.plan.tasks.map((t) => ({
          ...t,
          model: opts.workerModel!,
          tier: tierForSlug(opts.workerModel!),
        })),
      }
    : opts.plan;

  const fleetOptions: FleetOptions = {
    cwd: opts.cwd,
    concurrency: opts.concurrency,
    concurrencyProvider: opts.concurrencyProvider,
    memory: opts.memory ?? null,
    serverMemory: opts.serverMemory ?? null,
    store: opts.store ?? null,
    projectContext: opts.projectContext,
    agents: opts.agents,
    runner: createEngineRunner(opts.ai ? { ai: opts.ai } : {}),
    readOnly: opts.readOnly,
    isolation,
  };
  const fleet = opts.fleetFactory
    ? opts.fleetFactory(fleetOptions)
    : new Fleet(fleetOptions);
  opts.onFleet?.(fleet);

  if (opts.onTask) fleet.on("task", opts.onTask);
  if (opts.onUpdate) fleet.on("update", opts.onUpdate);
  const onAbort = (): void => fleet.cancelAll();
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    opts.store?.save(plan);
    fleet.loadPlan(plan);
    await fleet.start();
    const snapshot = fleet.snapshot();
    return {
      snapshot,
      summaryText: summarizeFleetRun(plan, snapshot),
      failedCount: snapshot.failedCount,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    if (opts.onTask) fleet.off("task", opts.onTask);
    if (opts.onUpdate) fleet.off("update", opts.onUpdate);
    if (isolation) await isolation.cleanupAll();
  }
}
