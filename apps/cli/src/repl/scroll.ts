/**
 * Pure scroll math for the full-screen transcript viewport.
 *
 * Ink has no virtualized-scroll primitive (a `Box` can only clip overflow at
 * its bottom edge, never render an arbitrary mid-content slice), so the
 * viewport pages at MESSAGE boundaries while tracking position at
 * estimated-ROW granularity: each message's on-screen height is estimated
 * from its content (wrapped text width, diff line count, or a fixed small
 * height for compact chips/badges). Framework-free and fully unit-testable —
 * no Ink, no terminal, no timers.
 *
 * Used only in full-screen mode (a real TTY, alternate screen buffer — see
 * alt-screen.ts). The classic inline mode relies on the terminal's own
 * scrollback instead and never touches this module.
 */
import type { Message } from "./components.js";

/** Estimated on-screen row height of one transcript message at `width` columns. */
export function estimateMessageRows(msg: Message, width: number): number {
  const w = Math.max(20, width);
  switch (msg.role) {
    case "stage":
    case "tool":
      return 1;
    case "terminal":
      // Collapsed accordion is one line; expanded shows its buffered output
      // plus the card's own border/header rows.
      return msg.terminalExpanded && msg.terminalRun
        ? Math.min(24, Math.max(3, msg.terminalRun.output.split("\n").length + 3))
        : 1;
    case "diff": {
      // Header line + roughly one terminal row per diff line (DiffView renders
      // one Text row per source line), capped so a huge diff can't blow the
      // estimate out — the viewport's overflow clip is the safety net either way.
      const lines = (msg.diff ?? "").split("\n").length;
      return Math.max(2, Math.min(60, lines + 2));
    }
    default: {
      if (msg.summary) return 6; // bordered card: verdict + review? + files + cost + borders
      if (msg.trace) return 20; // /replay card — tall, fixed estimate (rare, deliberate action)
      return wrappedRows(msg.content, w);
    }
  }
}

/** How many terminal rows `text` wraps to at `width` columns (word-wrap-ish estimate). */
function wrappedRows(text: string, width: number): number {
  if (!text) return 1;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / width));
  }
  return rows;
}

/** Sum of {@link estimateMessageRows} across a whole transcript. */
export function totalEstimatedRows(messages: readonly Message[], width: number): number {
  let total = 0;
  for (const m of messages) total += estimateMessageRows(m, width);
  return total;
}

export interface ScrollState {
  /** Last explicit scroll position, in estimated rows from the top. Ignored while `stickyBottom`. */
  rawOffset: number;
  /** True = pinned to the newest output; any explicit up-scroll clears it. */
  stickyBottom: boolean;
}

export interface ScrollCtx {
  /** Total estimated rows across all renderable messages, at the current viewport width. */
  totalLines: number;
  /** Visible viewport height, in rows. */
  viewportHeight: number;
}

export type ScrollAction =
  | { type: "line-up" }
  | { type: "line-down" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "half-up" }
  | { type: "half-down" }
  | { type: "home" }
  | { type: "end" };

export const INITIAL_SCROLL_STATE: ScrollState = { rawOffset: 0, stickyBottom: true };

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Largest valid offset — content never scrolls past its own top. */
export function maxOffsetFor(ctx: ScrollCtx): number {
  return Math.max(0, ctx.totalLines - ctx.viewportHeight);
}

/**
 * The offset actually used to render, resolving `stickyBottom` against the
 * LIVE content size — recomputed fresh every call, so a state pinned to the
 * bottom auto-follows newly streamed content with no extra wiring: the caller
 * just re-derives this each render from the current `ctx`.
 */
export function effectiveOffset(state: ScrollState, ctx: ScrollCtx): number {
  const max = maxOffsetFor(ctx);
  if (state.stickyBottom) return max;
  return clamp(state.rawOffset, 0, max);
}

/**
 * Pure reducer — never touches Ink, timers, or global state. `ctx` is passed
 * fresh on every dispatch (rather than stored in state) so it always reflects
 * the current viewport size and content length.
 */
export function scrollReducer(state: ScrollState, action: ScrollAction, ctx: ScrollCtx): ScrollState {
  const max = maxOffsetFor(ctx);
  const cur = effectiveOffset(state, ctx);
  /** Land on `n`, clamped; re-engage sticky-bottom automatically at the max. */
  const to = (n: number): ScrollState => {
    const next = clamp(n, 0, max);
    return { rawOffset: next, stickyBottom: next >= max };
  };
  switch (action.type) {
    case "line-up":
      return to(cur - 1);
    case "line-down":
      return to(cur + 1);
    case "page-up":
      return to(cur - Math.max(1, ctx.viewportHeight));
    case "page-down":
      return to(cur + Math.max(1, ctx.viewportHeight));
    case "half-up":
      return to(cur - Math.max(1, Math.ceil(ctx.viewportHeight / 2)));
    case "half-down":
      return to(cur + Math.max(1, Math.ceil(ctx.viewportHeight / 2)));
    case "home":
      return { rawOffset: 0, stickyBottom: false };
    case "end":
      return { rawOffset: max, stickyBottom: true };
    default:
      return state;
  }
}

export interface VisibleWindow {
  /** First message index to render (inclusive). */
  startIndex: number;
  /** One past the last message index to render (exclusive). */
  endIndex: number;
  /** Estimated rows above `startIndex` that scrolled off the top — feeds the "N lines above" indicator. */
  hiddenAbove: number;
}

/**
 * Which messages fall inside the viewport for the given offset. Ink can only
 * clip a Box's BOTTOM edge (there is no way to clip its top, i.e. render a
 * message partially scrolled off the top), so the window starts at the
 * message CONTAINING `offset` and grows message-by-message until it covers at
 * least `viewportHeight` rows — the caller clips any small overshoot at the
 * bottom with a fixed-height, `overflow: hidden` Box.
 */
export function computeVisibleWindow(
  rowHeights: readonly number[],
  offset: number,
  viewportHeight: number,
): VisibleWindow {
  if (rowHeights.length === 0) return { startIndex: 0, endIndex: 0, hiddenAbove: 0 };

  let acc = 0;
  let startIndex = 0;
  for (; startIndex < rowHeights.length; startIndex++) {
    const h = rowHeights[startIndex] ?? 0;
    if (acc + h > offset) break;
    acc += h;
  }
  if (startIndex >= rowHeights.length) startIndex = rowHeights.length - 1;

  let shown = 0;
  let endIndex = startIndex;
  for (; endIndex < rowHeights.length; endIndex++) {
    if (shown >= viewportHeight) break;
    shown += rowHeights[endIndex] ?? 0;
  }
  return { startIndex, endIndex: Math.max(endIndex, startIndex + 1), hiddenAbove: acc };
}
