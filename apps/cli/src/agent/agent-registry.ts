/**
 * The process-wide running-agent registry — the single source of truth for
 * "what is running right now", powering the REPL's `/hud` heads-up display.
 *
 * The CLI has several things that run concurrently once dispatched: the active
 * REPL turn, CI/PR pollers that fire-and-forget, and fleet subagents. Each
 * producer registers here and gets a
 * {@link AgentHandle} it updates as work progresses; consumers (the HUD) read a
 * {@link snapshot} and subscribe to `change` events for live updates.
 *
 * This is deliberately a lightweight in-memory singleton, not a cross-process
 * store: it tracks agents in the CURRENT process, exactly like Claude Code's
 * task HUD is scoped to your session. Finished entries linger briefly so a
 * completion is visible before it disappears, then are pruned.
 *
 * ── Killing a running agent ──────────────────────────────────────────────────
 * `remove(id)` only HIDES a roster row — it never stops the underlying work.
 * To actually cancel work there is a two-part seam:
 *   1. A producer (or the session owner, wiring a turn/subagent AbortController)
 *      associates an abort handle with an entry — either at registration
 *      (`RegisterInput.abort`) or afterwards via `registerAbort(id, handle)`.
 *      A handle is an `AbortController` OR a bare `() => void` abort function.
 *   2. A consumer (the swarm/HUD panel's "kill" affordance) calls `kill(id)`,
 *      which fires that abort handle, marks the entry `"killed"`, and KEEPS it
 *      visible (it lingers under the finished-TTL like `done`/`failed`) so the
 *      UI can show the outcome — it does NOT auto-remove; the UI decides when.
 * `kill` returns whether an abort handle actually existed, so a caller can tell
 * "cancelled real work" from "only marked a handle-less entry killed".
 */
import { EventEmitter } from "node:events";

export type AgentKind = "turn" | "subagent" | "fleet";
/**
 * `killed` is a TERMINAL status set by {@link AgentRegistry.kill} — the entry's
 * abort handle was fired (or it had none) and the roster row is retained briefly
 * so the kill is visible, then pruned like any other finished entry.
 */
export type AgentStatus = "queued" | "running" | "done" | "failed" | "killed";

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
  Pick<
    RunningAgent,
    "title" | "model" | "detail" | "status" | "outputTokens" | "costUsd"
  >
>;

/** Handle returned to a producer to drive its own entry. */
export interface AgentHandle {
  readonly id: string;
  /** Patch fields (merged). No-op after the entry is pruned. */
  update(patch: AgentPatch): void;
  /** Mark terminal. Defaults to "done"; pass "failed" for an error exit. */
  done(status?: "done" | "failed"): void;
}

/** An abort handle for an entry — a full `AbortController` or a bare abort fn. */
export type AbortHandle = AbortController | (() => void);

export interface RegisterInput {
  kind: AgentKind;
  title: string;
  model?: string;
  detail?: string;
  /** Initial status (default "running"). */
  status?: AgentStatus;
  /** Explicit id (default auto-generated); lets a caller reuse a known id. */
  id?: string;
  /**
   * Optional abort handle wired up front so {@link AgentRegistry.kill} can cancel
   * this agent's work. Equivalent to calling {@link AgentRegistry.registerAbort}
   * right after registration; use whichever is convenient (the controller is
   * often created around the dispatch, after `register`, in which case use
   * `registerAbort`). An `AbortController` or a bare `() => void`.
   */
  abort?: AbortHandle;
}

/** Aggregate counts for the HUD header. */
export interface AgentSummary {
  total: number;
  running: number;
  queued: number;
  done: number;
  failed: number;
  /** Entries stopped via {@link AgentRegistry.kill}. */
  killed: number;
}

const TERMINAL: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  "done",
  "failed",
  "killed",
]);

/** Normalize an {@link AbortHandle} to a plain abort function. */
function toAbortFn(handle: AbortHandle): () => void {
  return typeof handle === "function" ? handle : () => handle.abort();
}

export interface AgentRegistryOptions {
  /** Injectable clock (ms epoch) for deterministic tests. Default Date.now. */
  now?: () => number;
  /** How long a finished entry lingers before pruning (ms). Default 8000. */
  finishedTtlMs?: number;
}

export class AgentRegistry {
  private readonly entries = new Map<string, RunningAgent>();
  /**
   * Abort handles by agent id — the kill seam. Kept OFF {@link RunningAgent} so
   * the snapshot stays a plain data view (no functions leak to the UI/serializer).
   * An entry is dropped whenever its agent is removed or pruned so this never
   * outlives the roster row.
   */
  private readonly aborts = new Map<string, () => void>();
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
    if (input.abort) this.aborts.set(id, toAbortFn(input.abort));
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
      return aActive === 0
        ? a.startedAt - b.startedAt
        : b.updatedAt - a.updatedAt;
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
      killed: list.filter((a) => a.status === "killed").length,
    };
  }

  /** Subscribe to any change. Returns an unsubscribe fn. */
  on(listener: () => void): () => void {
    this.bus.on("change", listener);
    return () => this.bus.off("change", listener);
  }

  /**
   * Associate an abort handle with an already-registered agent, so a later
   * {@link kill} can cancel its work. The handle is an `AbortController` (whose
   * `.abort()` is called) or a bare `() => void`. A second call REPLACES the
   * previous handle. Returns true if the id exists (handle stored), false if it
   * is unknown/pruned. Prefer this when the controller is created around the
   * dispatch, after `register`; otherwise pass `abort` to `register` directly.
   */
  registerAbort(id: string, handle: AbortHandle): boolean {
    if (!this.entries.has(id)) return false;
    this.aborts.set(id, toAbortFn(handle));
    return true;
  }

  /**
   * Kill a running agent: fire its abort handle (if any), mark the entry
   * `"killed"`, and KEEP it visible — it lingers under the finished-TTL like a
   * `done`/`failed` entry so the kill is observable; it is NOT auto-removed (the
   * UI decides when to dismiss it via {@link remove}). Returns whether an abort
   * handle actually existed, so a caller can distinguish "cancelled real work"
   * from "marked a handle-less (or unknown) entry killed". No-op returning false
   * for an unknown/pruned id. A throwing abort handle never breaks the roster —
   * the entry is still marked killed.
   */
  kill(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    const abort = this.aborts.get(id);
    if (abort) {
      // The handle is consumed by the kill; drop it so a re-kill is a clean no-op
      // and the map never outlives its usefulness.
      this.aborts.delete(id);
      try {
        abort();
      } catch {
        // A producer's abort callback must never wedge the registry — the entry
        // is still transitioned to killed and the panel still updates.
      }
    }
    entry.status = "killed";
    entry.updatedAt = this.now();
    this.emitChange();
    return abort !== undefined;
  }

  /**
   * Drop a single agent by id — powers the REPL panel's "delete highlighted
   * agent" (Ctrl-X twice), which dismisses the entry from the Agent Team roster.
   * No-op if the id is unknown or already pruned. Note this only removes the
   * entry from the in-memory roster; it does not abort the underlying work (a
   * running turn keeps running) — use {@link kill} for that — it just hides it
   * from the panel. Any abort handle is dropped with the row (a dismissed entry
   * can no longer be killed, by construction).
   */
  remove(id: string): void {
    this.aborts.delete(id);
    if (this.entries.delete(id)) this.emitChange();
  }

  /** Test/reset helper — drop everything without emitting per-entry churn. */
  clear(): void {
    this.entries.clear();
    this.aborts.clear();
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
        this.aborts.delete(id);
        removed = true;
      }
    }
    if (removed) this.emitChange();
  }
}

/**
 * The process-wide singleton every producer and the HUD share. A single
 * instance means the REPL turn and any future in-process
 * fleet all surface in one `/hud`.
 */
export const agentRegistry = new AgentRegistry();
