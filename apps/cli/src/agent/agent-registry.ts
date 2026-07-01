/**
 * The process-wide running-agent registry — the single source of truth for
 * "what is running right now", powering the REPL's `/hud` heads-up display.
 *
 * The CLI has several things that run concurrently and were previously invisible
 * once dispatched: the active REPL turn, background monitors (CI/PR pollers that
 * fire-and-forget), and fleet subagents. Each producer registers here and gets a
 * {@link AgentHandle} it updates as work progresses; consumers (the HUD) read a
 * {@link snapshot} and subscribe to `change` events for live updates.
 *
 * This is deliberately a lightweight in-memory singleton, not a cross-process
 * store: it tracks agents in the CURRENT process, exactly like Claude Code's
 * task HUD is scoped to your session. Finished entries linger briefly so a
 * completion is visible before it disappears, then are pruned.
 */
import { EventEmitter } from "node:events";

export type AgentKind = "turn" | "subagent" | "monitor" | "fleet";
export type AgentStatus = "queued" | "running" | "done" | "failed";

/** A live view of one running (or just-finished) agent. */
export interface RunningAgent {
  id: string;
  kind: AgentKind;
  /** Human title — the goal/prompt/target, never a raw id. */
  title: string;
  /** Gateway model slug doing the work, when known. */
  model?: string;
  status: AgentStatus;
  /** ms epoch when it started. */
  startedAt: number;
  /** ms epoch of the last mutation. */
  updatedAt: number;
  /** Short live detail: current tool, poll target, last step. */
  detail?: string;
  /** Cumulative output tokens, when the producer tracks them. */
  outputTokens?: number;
  /** Cumulative cost in USD, when the producer tracks it. */
  costUsd?: number;
}

/** The mutable fields a producer may patch on its entry. */
export type AgentPatch = Partial<
  Pick<RunningAgent, "title" | "model" | "detail" | "status" | "outputTokens" | "costUsd">
>;

/** Handle returned to a producer to drive its own entry. */
export interface AgentHandle {
  readonly id: string;
  /** Patch fields (merged). No-op after the entry is pruned. */
  update(patch: AgentPatch): void;
  /** Mark terminal. Defaults to "done"; pass "failed" for an error exit. */
  done(status?: "done" | "failed"): void;
}

export interface RegisterInput {
  kind: AgentKind;
  title: string;
  model?: string;
  detail?: string;
  /** Initial status (default "running"). */
  status?: AgentStatus;
  /** Explicit id (default auto-generated); lets a caller reuse a known id. */
  id?: string;
}

/** Aggregate counts for the HUD header. */
export interface AgentSummary {
  total: number;
  running: number;
  queued: number;
  done: number;
  failed: number;
}

const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["done", "failed"]);

export interface AgentRegistryOptions {
  /** Injectable clock (ms epoch) for deterministic tests. Default Date.now. */
  now?: () => number;
  /** How long a finished entry lingers before pruning (ms). Default 8000. */
  finishedTtlMs?: number;
}

export class AgentRegistry {
  private readonly entries = new Map<string, RunningAgent>();
  private readonly bus = new EventEmitter();
  private readonly now: () => number;
  private readonly finishedTtlMs: number;
  private counter = 0;

  constructor(opts: AgentRegistryOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.finishedTtlMs = opts.finishedTtlMs ?? 8_000;
    // Many transient producers may subscribe/emit; lift the default 10-listener
    // warning cap so a busy session never prints a spurious leak warning.
    this.bus.setMaxListeners(0);
  }

  /** Register a new agent and return a handle to drive it. */
  register(input: RegisterInput): AgentHandle {
    const at = this.now();
    const id = input.id ?? `agent-${++this.counter}`;
    const entry: RunningAgent = {
      id,
      kind: input.kind,
      title: input.title,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      status: input.status ?? "running",
      startedAt: at,
      updatedAt: at,
    };
    this.entries.set(id, entry);
    this.emitChange();

    // Arrow functions capture `this` lexically, so the handle drives this
    // instance without aliasing `this` to a local.
    return {
      id,
      update: (patch: AgentPatch): void => {
        const cur = this.entries.get(id);
        if (!cur) return; // pruned — silently ignore late updates
        Object.assign(cur, patch, { updatedAt: this.now() });
        this.emitChange();
      },
      done: (status: "done" | "failed" = "done"): void => {
        const cur = this.entries.get(id);
        if (!cur) return;
        cur.status = status;
        cur.updatedAt = this.now();
        this.emitChange();
      },
    };
  }

  /**
   * Current agents, freshly pruned. Running/queued first (oldest start first),
   * then finished (most-recently-finished first) so the HUD reads top-to-bottom
   * as "active work, then what just completed".
   */
  snapshot(): RunningAgent[] {
    this.prune();
    return [...this.entries.values()].sort((a, b) => {
      const aActive = TERMINAL.has(a.status) ? 1 : 0;
      const bActive = TERMINAL.has(b.status) ? 1 : 0;
      if (aActive !== bActive) return aActive - bActive; // active group first
      return aActive === 0 ? a.startedAt - b.startedAt : b.updatedAt - a.updatedAt;
    });
  }

  /** Aggregate counts for the HUD header. */
  summary(): AgentSummary {
    const list = this.snapshot();
    return {
      total: list.length,
      running: list.filter((a) => a.status === "running").length,
      queued: list.filter((a) => a.status === "queued").length,
      done: list.filter((a) => a.status === "done").length,
      failed: list.filter((a) => a.status === "failed").length,
    };
  }

  /** Subscribe to any change. Returns an unsubscribe fn. */
  on(listener: () => void): () => void {
    this.bus.on("change", listener);
    return () => this.bus.off("change", listener);
  }

  /** Test/reset helper — drop everything without emitting per-entry churn. */
  clear(): void {
    this.entries.clear();
    this.emitChange();
  }

  private emitChange(): void {
    this.bus.emit("change");
  }

  /** Drop finished entries older than the TTL so the map never grows unbounded. */
  private prune(): void {
    const cutoff = this.now() - this.finishedTtlMs;
    let removed = false;
    for (const [id, e] of this.entries) {
      if (TERMINAL.has(e.status) && e.updatedAt < cutoff) {
        this.entries.delete(id);
        removed = true;
      }
    }
    if (removed) this.emitChange();
  }
}

/**
 * The process-wide singleton every producer and the HUD share. A single
 * instance means the REPL turn, background monitors, and any future in-process
 * fleet all surface in one `/hud`.
 */
export const agentRegistry = new AgentRegistry();
