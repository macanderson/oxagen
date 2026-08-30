/**
 * background-tracker.ts — the REPL's observer for the background dispatches IT
 * spawned (docs/specs/repl-async-dispatch.md §2.2, §2.3, §3.2).
 *
 * A `&`-suffixed or mode-triaged prompt is handed to a detached worker via
 * `dispatchDetachedSession` and then runs headless. This tracker closes the
 * loop back to the REPL WITHOUT inventing a second transport: it reuses the
 * ADR-023 `SessionStore` wire format — `tailEvents(sid)` for a per-session live
 * stream and `watchSessions` for the roster — filtered to the set of sessions
 * this REPL started.
 *
 * Two things it provides the REPL:
 *   1. Fold-back — on a session's terminal event it calls `onNotify` with a
 *      compact, attributed one-liner (the same shape as the inline fleet
 *      summary) that the REPL appends to the transcript. Never re-focuses.
 *   2. A concurrency cap — `reserve()`/`release()` count in-flight dispatches
 *      synchronously (before the <50 ms spawn resolves) so the REPL can queue
 *      locally past `maxConcurrent` instead of spawning unbounded workers. This
 *      is the in-REPL enforcement the CLI lacks today (fleet only warns).
 *
 * Attribution safety: only sids passed to `add()` are ever surfaced, so a
 * session started from another terminal never leaks into this transcript.
 *
 * Slot accounting is a single balanced counter: `reserve()` is the one +1
 * (taken at decision time), and each reserved slot is released exactly once —
 * either by `release()` when the spawn itself fails before `add()`, or by
 * `finish()` when the session reaches a terminal/orphaned state. `finish()` is
 * idempotent per sid and can be driven by EITHER the event tail (rich data:
 * summary, files, cost) OR the roster backstop (a worker that crashed without
 * writing `session.end` still derives to `orphaned`).
 *
 * The balance therefore rests on ONE caller contract: every `reserve()` that
 * returns true must be followed by exactly one `add()` with a sid never seen
 * before, or by one `release()`. `add()` no-ops on a repeat sid (and after
 * `dispose()`), which would strand that slot for the life of the REPL — sids
 * come from `dispatchDetachedSession`, so a repeat should be impossible, but
 * that is the assumption the counter depends on rather than something it
 * enforces.
 *
 * `entries` is append-only: a finished dispatch keeps its row so the panel can
 * still show it. That is bounded by how many dispatches one REPL session
 * starts, not by time.
 */
import type { SessionEvent, SessionState } from "../sessions/events.js";
import { shortSid } from "../sessions/ids.js";
import type {
  SessionMetaView,
  SessionStore,
  TailHandle,
} from "../sessions/store.js";

/** One compact row in the Background dispatches panel. */
export interface BackgroundRow {
  sid: string;
  title: string;
  /** Roster-derived lifecycle state (`orphaned` = the worker's pid is dead). */
  state: SessionState | "orphaned";
  /** Short live detail (last activity / summary), never a raw id. */
  detail: string;
  /** Cumulative cost so far, USD. */
  costUsd: number;
  /** Turns completed so far. */
  turns: number;
}

export interface BackgroundTrackerOptions {
  store: SessionStore;
  /** Fold a terminal one-liner into the transcript (append-only, no re-focus). */
  onNotify: (line: string) => void;
  /** Publish the current roster of tracked dispatches for the panel. */
  onRoster: (rows: BackgroundRow[]) => void;
  /** Called when a slot frees (a dispatch finished) so the caller can drain a local queue. */
  onSlotFree?: () => void;
  /** Max concurrent in-flight dispatches. Default 4. */
  maxConcurrent?: number;
}

export interface BackgroundTracker {
  /**
   * Synchronously claim a dispatch slot. Returns true (and counts the slot) when
   * under the cap, false when at it. A successful reserve MUST be balanced by a
   * later `add()` (which the eventual terminal releases) or a `release()`.
   */
  reserve(): boolean;
  /** Release a reserved slot whose dispatch never started (spawn failed). */
  release(): void;
  /** Register a spawned session so its progress + completion surface here. */
  add(sid: string, title: string): void;
  /** True when a new dispatch may start right now (under the cap). */
  canDispatch(): boolean;
  /** Count of in-flight (reserved-or-running) dispatches. */
  runningCount(): number;
  /** Current cap. */
  maxConcurrent(): number;
  /** Change the cap live (e.g. from `/dispatch cap <n>`). Frees drainers if it grew. */
  setMaxConcurrent(n: number): void;
  /** Stop every tail + the roster watch. Idempotent. */
  dispose(): void;
}

interface TrackedEntry {
  title: string;
  done: boolean;
  tail: TailHandle | null;
  /** Distinct files touched across the session's diffs/turns. */
  files: Set<string>;
  /** Latest cumulative cost seen from `usage`/`turn.end` events. */
  costUsd: number;
}

/** States a session can no longer emit past — the roster backstop for slot release. */
function isTerminalState(state: SessionState | "orphaned"): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "orphaned"
  );
}

/** Map a roster-derived state onto the accurate terminal outcome for the fold line. */
function outcomeForRosterState(
  state: SessionState | "orphaned",
): "done" | "failed" | "cancelled" {
  if (state === "done") return "done";
  if (state === "cancelled") return "cancelled";
  // failed AND orphaned (a crashed/killed worker) both read as a failure.
  return "failed";
}

/**
 * The attributed one-liner folded into the transcript on completion — same
 * spirit as `summarizeFleetRun`, keyed by the short sid + title so the user
 * always sees WHICH dispatch finished, never a raw UUID.
 */
export function formatFoldLine(input: {
  sid: string;
  title: string;
  outcome: "done" | "failed" | "cancelled";
  summary: string;
  fileCount: number;
  costUsd: number;
}): string {
  const glyph =
    input.outcome === "done" ? "◇" : input.outcome === "failed" ? "✗" : "◌";
  const verb =
    input.outcome === "done"
      ? "done"
      : input.outcome === "failed"
        ? "failed"
        : "cancelled";
  const summary = input.summary.replace(/\s+/g, " ").trim();
  const parts: string[] = [summary ? `${verb}: ${summary}` : verb];
  if (input.fileCount > 0) {
    parts.push(`${input.fileCount} file${input.fileCount === 1 ? "" : "s"}`);
  }
  if (input.costUsd > 0) parts.push(`$${input.costUsd.toFixed(2)}`);
  return `${glyph} ${shortSid(input.sid)} "${input.title}" — ${parts.join(" · ")}`;
}

export function createBackgroundTracker(
  opts: BackgroundTrackerOptions,
): BackgroundTracker {
  const entries = new Map<string, TrackedEntry>();
  let slots = 0;
  let cap = opts.maxConcurrent ?? 4;
  let disposed = false;

  const finish = (
    sid: string,
    outcome: "done" | "failed" | "cancelled",
    summary: string,
    costUsd: number,
  ): void => {
    const entry = entries.get(sid);
    if (!entry || entry.done) return;
    entry.done = true;
    entry.tail?.stop();
    entry.tail = null;
    slots = Math.max(0, slots - 1);
    opts.onNotify(
      formatFoldLine({
        sid,
        title: entry.title,
        outcome,
        summary,
        fileCount: entry.files.size,
        costUsd,
      }),
    );
    opts.onSlotFree?.();
  };

  const onEvent = (sid: string, event: SessionEvent): void => {
    const entry = entries.get(sid);
    if (!entry || entry.done) return;
    switch (event.type) {
      case "diff":
        for (const f of event.changedFiles) entry.files.add(f);
        break;
      case "turn.end":
        for (const f of event.changedFiles) entry.files.add(f);
        entry.costUsd = event.usage.costUsd;
        break;
      case "usage":
        entry.costUsd = event.cumulative.costUsd;
        break;
      case "error":
        if (event.fatal) finish(sid, "failed", event.message, entry.costUsd);
        break;
      case "session.end":
        finish(sid, event.state, event.summary, event.usage.costUsd);
        break;
      default:
        break;
    }
  };

  // Roster watch: powers the panel AND is the backstop that releases a slot for
  // a worker that died without writing `session.end` (derives to `orphaned`).
  const rosterWatch: TailHandle = opts.store.watchSessions(
    (sessions: SessionMetaView[]) => {
      if (disposed) return;
      const rows: BackgroundRow[] = [];
      for (const meta of sessions) {
        if (!entries.has(meta.sid)) continue;
        rows.push({
          sid: meta.sid,
          title: meta.title,
          state: meta.derivedState,
          detail: meta.lastActivity ?? meta.summary ?? "",
          costUsd: meta.usage.costUsd,
          turns: meta.turns,
        });
        const entry = entries.get(meta.sid);
        if (entry && !entry.done && isTerminalState(meta.derivedState)) {
          finish(
            meta.sid,
            outcomeForRosterState(meta.derivedState),
            meta.summary ?? "",
            meta.usage.costUsd,
          );
        }
      }
      opts.onRoster(rows);
    },
  );

  return {
    reserve(): boolean {
      if (disposed || slots >= cap) return false;
      slots += 1;
      return true;
    },
    release(): void {
      slots = Math.max(0, slots - 1);
      if (!disposed) opts.onSlotFree?.();
    },
    add(sid: string, title: string): void {
      if (disposed || entries.has(sid)) return;
      const entry: TrackedEntry = {
        title,
        done: false,
        tail: null,
        files: new Set<string>(),
        costUsd: 0,
      };
      entries.set(sid, entry);
      entry.tail = opts.store.tailEvents(sid, (event) => onEvent(sid, event));
    },
    canDispatch(): boolean {
      return !disposed && slots < cap;
    },
    runningCount(): number {
      return slots;
    },
    maxConcurrent(): number {
      return cap;
    },
    setMaxConcurrent(n: number): void {
      const next = Math.max(1, Math.floor(n));
      const grew = next > cap;
      cap = next;
      if (grew && !disposed) opts.onSlotFree?.();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      rosterWatch.stop();
      for (const entry of entries.values()) {
        entry.tail?.stop();
        entry.tail = null;
      }
    },
  };
}
