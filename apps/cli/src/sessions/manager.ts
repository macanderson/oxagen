/**
 * The fleet session manager (ADR-023) — the TUI-side owner of many in-process
 * runners AND the observer of every foreign session in the project's fleet.
 *
 * Two jobs, one object:
 *
 *   1. **Own runners.** `dispatch` mints a sid and returns it SYNCHRONOUSLY —
 *      the composer is never blocked (ADR-023 decision 4). The session starts
 *      in-process (up to `concurrency`; the rest queue FIFO and start as slots
 *      free). `dispatchDetached` instead spawns a hidden `fleet worker <sid>`
 *      so a script can dispatch and exit.
 *
 *   2. **Observe the fleet.** `start()` watches the store's roster and tails the
 *      events of every ACTIVE session this process does NOT own, merging them —
 *      with its own in-process runners' RAW bus events — onto ONE emitter. That
 *      is what makes a second terminal's dispatch appear in Mission Control
 *      within a second, read-only but controllable (send/cancel via the inbox).
 *
 * The invariant that keeps the aggregate correct: an in-process session is fed to
 * the bus by its runner's `onLocalEvent` and is NEVER also tailed from disk, so
 * its events are emitted exactly once (`ownSids` gates the tail).
 */
import { EventEmitter } from "node:events";
import type { AgentAi } from "@oxagen/agent-engine";
import { emptyTurnUsage, type SessionEvent } from "./events.js";
import { newSessionId } from "./ids.js";
import {
  isActiveState,
  type SessionMeta,
  type SessionMetaView,
  type SessionStore,
  type TailHandle,
} from "./store.js";
import {
  dispatchDetachedSession,
  titleFromPrompt,
  type DispatchDetachedOptions,
} from "./dispatch.js";
import { runSession, type SessionFate } from "./runner.js";
import { debugLog } from "../lib/debug-log.js";

/** How a caller asks for new work. `mode` defaults differ by entry point (see methods). */
export interface DispatchOptions {
  prompt: string;
  model?: string;
  agent?: string;
  mode?: "conversation" | "once";
}

export interface FleetSessionManagerOptions {
  store: SessionStore;
  /** Project working directory every session in this fleet operates on. */
  cwd: string;
  /** Max in-process runners at once (default 4); excess sessions queue FIFO. */
  concurrency?: number;
  /**
   * Detached-worker spawner, forwarded to {@link dispatchDetachedSession}.
   * Injectable for tests; omitted ⇒ the real `child_process.spawn` re-exec.
   */
  spawnImpl?: DispatchDetachedOptions["spawnImpl"];
  /** Inject a fake `runSession` in tests; defaults to the real runner. */
  runSessionImpl?: typeof runSession;
  /**
   * AI port handed to every in-process runner. Omitted ⇒ each runner builds its
   * own BYOK gateway-direct port (see {@link runSession}).
   */
  ai?: AgentAi;
  /** Clock injection for deterministic ids / timestamps in tests. */
  now?: () => number;
}

/** The typed event surface — one merged stream + roster changes. */
interface ManagerEvents {
  /** Every session event: in-process runners' RAW bus events + foreign tails. */
  event: (event: SessionEvent) => void;
  /** The full roster on any change (state, usage, add/remove). */
  roster: (sessions: SessionMetaView[]) => void;
}

export class FleetSessionManager {
  private readonly store: SessionStore;
  private readonly cwd: string;
  private readonly concurrency: number;
  private readonly spawnImpl: DispatchDetachedOptions["spawnImpl"];
  private readonly runSessionImpl: typeof runSession;
  private readonly ai: AgentAi | undefined;
  private readonly now: () => number;

  // Composed (not extended) so the `event`/`roster` surface is precisely typed
  // instead of inheriting EventEmitter's `(...args: any[])` signatures.
  private readonly emitter = new EventEmitter();

  /** In-process runners by sid → their settle promise. */
  private readonly runners = new Map<string, Promise<{ state: SessionFate }>>();
  /** Sessions created but not yet started (concurrency overflow), FIFO. */
  private readonly pendingQueue: Array<{ sid: string; meta: SessionMeta }> = [];
  /** Sessions this process runs in-process — never tailed from disk. */
  private readonly ownSids = new Set<string>();
  /** Live event tails for foreign (not-owned) active sessions. */
  private readonly tails = new Map<string, TailHandle>();
  /** Highest seq emitted per foreign session (resume + dedupe). */
  private readonly lastSeen = new Map<string, number>();

  private roster = new Map<string, SessionMetaView>();
  private watchHandle: TailHandle | null = null;
  private started = false;
  private draining = false;

  constructor(opts: FleetSessionManagerOptions) {
    this.store = opts.store;
    this.cwd = opts.cwd;
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.runSessionImpl = opts.runSessionImpl ?? runSession;
    this.ai = opts.ai;
    this.now = opts.now ?? Date.now;
    this.spawnImpl = opts.spawnImpl;
    // Foreign fleets can be large; lift the default listener cap so a busy
    // aggregate view (one listener per surface) never trips a spurious warning.
    this.emitter.setMaxListeners(0);
  }

  // ── Typed event surface ─────────────────────────────────────────────────────

  on<K extends keyof ManagerEvents>(
    event: K,
    listener: ManagerEvents[K],
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof ManagerEvents>(
    event: K,
    listener: ManagerEvents[K],
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  /**
   * Dispatch new work as an IN-PROCESS session. Returns the sid synchronously
   * (the composer never blocks); the session is created + started asynchronously
   * and its events flow once it exists. Conversational by default.
   */
  dispatch(opts: DispatchOptions): string {
    const sid = newSessionId(this.now());
    this.ownSids.add(sid);
    void this.initInProcess(sid, opts).catch((err: unknown) => {
      this.ownSids.delete(sid);
      void debugLog("error", "fleet.dispatch-init-failed", {
        sid,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return sid;
  }

  /**
   * Dispatch new work as a DETACHED worker so the caller can exit. Delegates to
   * the shared {@link dispatchDetachedSession} — the ONE path that owns session
   * creation (owner "worker", pid 0) and the detached re-exec — passing this
   * manager's store + cwd through and forwarding the injectable `spawnImpl`.
   * Conversational by default (ADR-023 decision 5 / spec §3). Returns the sid.
   */
  async dispatchDetached(opts: DispatchOptions): Promise<string> {
    const { sid } = await dispatchDetachedSession({
      cwd: this.cwd,
      prompt: opts.prompt,
      model: opts.model,
      agent: opts.agent,
      mode: opts.mode,
      store: this.store,
      spawnImpl: this.spawnImpl,
    });
    return sid;
  }

  private async initInProcess(
    sid: string,
    opts: DispatchOptions,
  ): Promise<void> {
    const meta = await this.store.createSession({
      sid,
      title: titleFromPrompt(opts.prompt),
      prompt: opts.prompt,
      owner: "tui",
      pid: process.pid,
      cwd: this.cwd,
      mode: opts.mode ?? "conversation",
      model: opts.model,
      agent: opts.agent,
      state: "queued",
    });
    this.pendingQueue.push({ sid, meta });
    this.maybeStart();
  }

  /** Fill open concurrency slots with queued sessions (FIFO). */
  private maybeStart(): void {
    if (this.draining) return;
    while (
      this.runners.size < this.concurrency &&
      this.pendingQueue.length > 0
    ) {
      const item = this.pendingQueue.shift() as {
        sid: string;
        meta: SessionMeta;
      };
      this.startRunner(item.sid, item.meta);
    }
  }

  private startRunner(sid: string, meta: SessionMeta): void {
    const promise = this.runSessionImpl({
      store: this.store,
      meta,
      ai: this.ai,
      onLocalEvent: (event) => this.emitter.emit("event", event),
    })
      .catch((err: unknown): { state: SessionFate } => {
        void debugLog("error", "fleet.runner-crash", {
          sid,
          message: err instanceof Error ? err.message : String(err),
        });
        return { state: "failed" };
      })
      .finally(() => {
        this.runners.delete(sid);
        this.maybeStart();
      });
    this.runners.set(sid, promise);
  }

  // ── Control (any session, owned or foreign) ──────────────────────────────────

  /** Append a follow-up message to `sid`'s inbox (its owner consumes it). */
  async send(sid: string, text: string): Promise<void> {
    await this.store.appendInbox(sid, {
      type: "message",
      text,
      ts: this.now(),
    });
  }

  /**
   * Request cancellation: append a `cancel` to the inbox always, and — for a
   * FOREIGN, alive worker — also SIGTERM the owner pid so a wedged worker dies.
   * An in-process session's own runner consumes the inbox cancel; we never
   * signal our own pid.
   */
  async cancel(sid: string): Promise<void> {
    await this.store.appendInbox(sid, { type: "cancel", ts: this.now() });
    if (this.ownSids.has(sid)) return;
    const meta =
      this.roster.get(sid) ?? (await this.store.readMeta(sid)) ?? undefined;
    if (meta && meta.owner === "worker" && meta.alive && meta.pid > 0) {
      try {
        process.kill(meta.pid, "SIGTERM");
      } catch {
        // Owner already gone (ESRCH) or not ours (EPERM) — the inbox cancel stands.
      }
    }
  }

  // ── Aggregate observation ────────────────────────────────────────────────────

  /** Begin watching the roster and adopting foreign active sessions. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.watchHandle = this.store.watchSessions((sessions) =>
      this.onRoster(sessions),
    );
  }

  /** Tear down all tails and the roster watch. Runners are unaffected (see drain). */
  stop(): void {
    this.started = false;
    this.watchHandle?.stop();
    this.watchHandle = null;
    for (const tail of this.tails.values()) tail.stop();
    this.tails.clear();
  }

  private onRoster(sessions: SessionMetaView[]): void {
    this.roster = new Map(sessions.map((s) => [s.sid, s]));

    // Adopt: tail every ACTIVE session we don't own and aren't already tailing.
    for (const s of sessions) {
      if (this.ownSids.has(s.sid)) continue; // own → events arrive via onLocalEvent
      if (isActiveState(s.derivedState) && !this.tails.has(s.sid)) {
        this.startForeignTail(s.sid);
      }
    }
    // Release tails for sessions that vanished (cleaned).
    for (const sid of [...this.tails.keys()]) {
      if (!this.roster.has(sid)) {
        this.tails.get(sid)?.stop();
        this.tails.delete(sid);
        this.lastSeen.delete(sid);
      }
    }

    this.emitter.emit("roster", sessions);
  }

  private startForeignTail(sid: string): void {
    const fromSeq = (this.lastSeen.get(sid) ?? 0) + 1;
    const handle = this.store.tailEvents(
      sid,
      (event) => {
        const seen = this.lastSeen.get(sid) ?? 0;
        if (event.seq <= seen) return; // dedupe across a tail restart
        this.lastSeen.set(sid, event.seq);
        this.emitter.emit("event", event);
      },
      { fromSeq },
    );
    this.tails.set(sid, handle);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /**
   * Stop dispatching NEW work and wait for in-process runners to settle
   * (mirrors {@link Fleet.drain}). Queued-but-never-started sessions are
   * finalized `cancelled` immediately; detached/foreign sessions are untouched.
   */
  async drain(): Promise<void> {
    this.draining = true;
    const queued = this.pendingQueue.splice(0);
    await Promise.all(
      queued.map(({ meta }) => this.cancelQueued(meta).catch(() => {})),
    );
    await Promise.allSettled([...this.runners.values()]);
  }

  /** Finalize a session that was created but never got a runner (drained pre-start). */
  private async cancelQueued(meta: SessionMeta): Promise<void> {
    const writer = this.store.openWriter(meta);
    const event = writer.append({
      type: "session.end",
      state: "cancelled",
      summary: "cancelled (drained before start)",
      durationMs: 0,
      usage: emptyTurnUsage(),
    });
    this.emitter.emit("event", event);
    writer.patchMeta({ state: "cancelled", endedAt: this.now() });
    await writer.flush();
  }

  // ── Introspection ────────────────────────────────────────────────────────────

  /** In-process runners currently active. */
  get runningCount(): number {
    return this.runners.size;
  }

  /** Sessions created but waiting for a concurrency slot. */
  get queuedCount(): number {
    return this.pendingQueue.length;
  }

  /** Current roster snapshot, newest first. */
  rosterSnapshot(): SessionMetaView[] {
    return [...this.roster.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
