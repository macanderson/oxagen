/**
 * lib.ts — the pure, framework-free helpers behind Mission Control (spec §5).
 *
 * Everything here is a plain function over plain data: session-color hashing,
 * the elapsed/clock formatters, the state glyph vocabulary, roster arithmetic,
 * the composer's `@sid` parse, the single-line editor reducer, and the fold
 * that turns a session's raw event stream into renderable transcript items.
 * Keeping this Ink-free is what lets the whole surface be unit-tested without a
 * terminal — the components are then thin presentational shells over these.
 */
import { theme } from "../theme.js";
import type {
  SessionEvent,
  SessionState,
  TurnUsage,
} from "../../sessions/events.js";
import { emptyTurnUsage } from "../../sessions/events.js";
import { isActiveState, type SessionMetaView } from "../../sessions/store.js";

// ── Session color ────────────────────────────────────────────────────────────

/**
 * The stable per-session tint palette — the same 8 brand tones the slash-command
 * menu uses, reused here so each agent's lines carry a consistent, distinct
 * gutter color across the aggregate timeline and the rail.
 */
export const SESSION_COLORS: readonly string[] = theme.commandPalette;

/**
 * Map a session id to a stable color from {@link SESSION_COLORS}. A djb2 hash of
 * the id (not its list position) keeps a session the same color for its whole
 * life, even as the roster reorders — the eye tracks work by color.
 */
export function colorForSid(sid: string): string {
  let h = 5381;
  for (let i = 0; i < sid.length; i++)
    h = ((h << 5) + h + sid.charCodeAt(i)) >>> 0;
  return SESSION_COLORS[h % SESSION_COLORS.length] as string;
}

// ── Time formatting ──────────────────────────────────────────────────────────

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `137000` → `"2:17"`, `3723000` → `"1:02:03"`. Whole-second resolution. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** A wall-clock `HH:MM:SS` gutter stamp for one event's local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * A short, human duration: `12ms` / `1.2s` / `2m31s`. Re-exported from the
 * aggregate-line leaf rather than reimplemented, so a tool chip reads the same
 * in the Focus and Aggregate views by construction instead of by convention.
 */
export { formatDurationMs } from "./aggregate-line.js";

// ── State glyphs ─────────────────────────────────────────────────────────────

export interface Glyph {
  ch: string;
  color: string;
}

/** The one-glyph vocabulary for a session's derived lifecycle state. */
export function stateGlyph(state: SessionState | "orphaned"): Glyph {
  switch (state) {
    case "running":
      return { ch: "●", color: theme.cyan };
    case "waiting":
      return { ch: "◐", color: theme.amber };
    case "queued":
      return { ch: "◔", color: theme.dim };
    case "done":
      return { ch: "✓", color: theme.green };
    case "failed":
      return { ch: "✖", color: theme.red };
    case "cancelled":
      return { ch: "◼", color: theme.dim };
    case "orphaned":
      return { ch: "⚠", color: theme.orange };
  }
}

// ── Roster arithmetic ────────────────────────────────────────────────────────

export interface StateCounts {
  running: number;
  waiting: number;
  queued: number;
  done: number;
  failed: number;
  cancelled: number;
  orphaned: number;
}

/** Tally the roster by derived state — the vitals bar's headline numbers. */
export function countByState(
  sessions: readonly SessionMetaView[],
): StateCounts {
  const counts: StateCounts = {
    running: 0,
    waiting: 0,
    queued: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
    orphaned: 0,
  };
  for (const s of sessions) counts[s.derivedState] += 1;
  return counts;
}

/**
 * Whether Mission Control has any time display that must keep advancing on its
 * own — a live elapsed clock on an active session, or the drain readout. True
 * while any session is queued/running/waiting, or the fleet is draining.
 *
 * When this is false, nothing on screen changes second-to-second: the state
 * glyphs are static, no elapsed clock is live (finished sessions show their
 * final duration), so the render pump can idle entirely instead of redrawing an
 * identical frame ten times a second. This is the gate for the animation tick.
 */
export function hasLiveTimers(
  sessions: readonly SessionMetaView[],
  draining: boolean,
): boolean {
  return draining || sessions.some((s) => isActiveState(s.derivedState));
}

/** Sum usage across the roster — cumulative tokens + cost for the whole fleet. */
export function sumUsage(sessions: readonly SessionMetaView[]): TurnUsage {
  return sessions.reduce<TurnUsage>((acc, s) => {
    acc.inputTokens += s.usage.inputTokens;
    acc.outputTokens += s.usage.outputTokens;
    acc.costUsd += s.usage.costUsd;
    return acc;
  }, emptyTurnUsage());
}

// ── Composer parsing ─────────────────────────────────────────────────────────

/**
 * Parse a composer line that targets a session: `@<sidref> rest…` → the ref and
 * the remainder. Returns `null` when the line does not begin with `@`. An empty
 * `rest` (`@k3x`) is a valid parse the caller may treat as "just select".
 */
export function parseAtRef(raw: string): { ref: string; rest: string } | null {
  const m = /^@(\S+)\s*([\s\S]*)$/.exec(raw);
  if (!m) return null;
  return { ref: m[1] as string, rest: (m[2] ?? "").trim() };
}

// ── Single-line editor ───────────────────────────────────────────────────────

export interface LineState {
  value: string;
  /** Insertion point, `0..value.length`. */
  cursor: number;
}

export type LineEdit =
  | { t: "insert"; ch: string }
  | { t: "backspace" }
  | { t: "delete" }
  | { t: "left" }
  | { t: "right" }
  | { t: "home" }
  | { t: "end" }
  | { t: "clear" };

/** The empty line. */
export function emptyLine(): LineState {
  return { value: "", cursor: 0 };
}

/**
 * Apply one edit to a single-line buffer, purely. Cursor moves are clamped to
 * the buffer; `insert` can carry a multi-char string (a paste) and advances the
 * cursor past it. This is the whole text model the composer needs — richer
 * editing (the REPL's `PromptInput`) is deliberately not imported (spec §5).
 */
export function editLine(state: LineState, edit: LineEdit): LineState {
  const { value, cursor } = state;
  switch (edit.t) {
    case "insert":
      return {
        value: value.slice(0, cursor) + edit.ch + value.slice(cursor),
        cursor: cursor + edit.ch.length,
      };
    case "backspace":
      return cursor === 0
        ? state
        : {
            value: value.slice(0, cursor - 1) + value.slice(cursor),
            cursor: cursor - 1,
          };
    case "delete":
      return cursor >= value.length
        ? state
        : { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
    case "left":
      return { value, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { value, cursor: Math.min(value.length, cursor + 1) };
    case "home":
      return { value, cursor: 0 };
    case "end":
      return { value, cursor: value.length };
    case "clear":
      return emptyLine();
  }
}

// ── Focus transcript fold ────────────────────────────────────────────────────

export type FocusItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | {
      kind: "tool";
      name: string;
      running: boolean;
      ok?: boolean;
      durationMs?: number;
    }
  | { kind: "stage"; label: string; detail?: string }
  | { kind: "diff"; changedFiles: string[]; changedLines: number }
  | { kind: "error"; message: string; fatal: boolean }
  | { kind: "end"; state: "done" | "failed" | "cancelled"; summary: string };

/**
 * Fold a session's raw event stream into ordered transcript items for the Focus
 * view. Assistant text is accumulated from `message.delta` for live feel, then
 * REPLACED by the authoritative full text on `message.end` — so the same fold
 * is correct whether it reads coalesced chunks off disk or raw chunks off the
 * bus. `tool.end` settles the most recent still-running tool of the same name.
 * Reasoning deltas are intentionally dropped (the Focus view shows work + prose,
 * not the model's private scratchpad).
 */
export function foldFocusEvents(events: readonly SessionEvent[]): FocusItem[] {
  const items: FocusItem[] = [];

  const finalizeStreaming = (): void => {
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming)
      last.streaming = false;
  };
  const openAssistant = (): Extract<FocusItem, { kind: "assistant" }> => {
    const last = items[items.length - 1];
    if (last && last.kind === "assistant" && last.streaming) return last;
    const next = { kind: "assistant" as const, text: "", streaming: true };
    items.push(next);
    return next;
  };

  for (const e of events) {
    switch (e.type) {
      case "message":
        finalizeStreaming();
        items.push({ kind: "user", text: e.text });
        break;
      case "message.delta":
        openAssistant().text += e.text;
        break;
      case "message.end": {
        const block = openAssistant();
        block.text = e.text;
        block.streaming = false;
        break;
      }
      case "stage":
        items.push(
          e.detail !== undefined
            ? { kind: "stage", label: e.label, detail: e.detail }
            : { kind: "stage", label: e.label },
        );
        break;
      case "tool.start":
        items.push({ kind: "tool", name: e.name, running: true });
        break;
      case "tool.end": {
        // Scan backwards in place: copying + reversing `items` on every
        // tool.end made the fold O(n²) in allocation, and this fold re-runs
        // over a session's WHOLE event log on each Focus-view refresh.
        let open: Extract<FocusItem, { kind: "tool" }> | undefined;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it && it.kind === "tool" && it.running && it.name === e.name) {
            open = it;
            break;
          }
        }
        if (open) {
          open.running = false;
          open.ok = e.ok;
          open.durationMs = e.durationMs;
        } else {
          items.push({
            kind: "tool",
            name: e.name,
            running: false,
            ok: e.ok,
            durationMs: e.durationMs,
          });
        }
        break;
      }
      case "diff":
        if (e.changedFiles.length > 0) {
          items.push({
            kind: "diff",
            changedFiles: e.changedFiles,
            changedLines: e.changedLines,
          });
        }
        break;
      case "turn.end":
        finalizeStreaming();
        break;
      case "error":
        finalizeStreaming();
        items.push({ kind: "error", message: e.message, fatal: e.fatal });
        break;
      case "session.end":
        finalizeStreaming();
        items.push({ kind: "end", state: e.state, summary: e.summary });
        break;
      default:
        // session.start, session.state, reasoning.delta, usage — not shown here.
        break;
    }
  }
  return items;
}
