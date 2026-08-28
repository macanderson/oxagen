/**
 * Pure scroll math for the full-screen transcript viewport.
 *
 * Ink has no virtualized-scroll primitive, but an `overflow: hidden` Box DOES
 * clip content on ALL edges (Ink ≥4 computes a full x1/y1/x2/y2 clip region —
 * see ink's render-node-to-output), so the viewport achieves LINE-exact
 * scrolling: it windows whole messages for cheap layout, then slides the
 * window's first message partially off the top with a negative `marginTop`
 * (`clipTop` below). Message heights are still ESTIMATED from content
 * (wrapped text width, diff line count, fixed heights for compact chips) —
 * estimates only steer which messages get windowed and the scrollbar math;
 * they can no longer make content unreachable, because `clipTop` covers every
 * row WITHIN the window's first message, including one taller than the whole
 * viewport. Framework-free and fully unit-testable — no Ink, no terminal, no
 * timers.
 *
 * Used only in full-screen mode (a real TTY, alternate screen buffer — see
 * alt-screen.ts). The classic inline mode relies on the terminal's own
 * scrollback instead and never touches this module.
 */
import type { Message } from "./components.js";

/**
 * How many diff lines DiffView renders before truncating with a one-line note
 * (mirrors diff-view.tsx's DEFAULT_MAX_LINES — kept in sync by
 * scroll.test.ts).
 */
const DIFF_VIEW_MAX_LINES = 500;

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
        ? Math.min(
            24,
            Math.max(3, msg.terminalRun.output.split("\n").length + 3),
          )
        : 1;
    case "diff": {
      // Must track DiffMessage's REAL rendered height: marginY (2 rows) +
      // header (1) + one row per diff line up to DiffView's own truncation
      // cap (+1 for its "… more lines" note past it). Capping this estimate
      // below DiffView's real render would make scroll positions vanish from
      // the math and leave everything above the cap unreachable. Tall diffs
      // are line-scrollable (clipTop), so the estimate must match the real
      // height, not an arbitrary cap.
      const lines = (msg.diff ?? "").split("\n").length;
      const rendered =
        Math.min(lines, DIFF_VIEW_MAX_LINES) +
        (lines > DIFF_VIEW_MAX_LINES ? 1 : 0);
      return Math.max(2, rendered + 3);
    }
    case "user": {
      // MessageView previews a prompt at 4 lines + a one-line Ctrl-O expand
      // hint (previewLines in components.tsx) — the FULL content never
      // renders in the viewport, so estimating it would overshoot by the
      // whole hidden remainder.
      const rows = wrappedRows(msg.content, w);
      return rows > 4 ? 5 : rows;
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
export function totalEstimatedRows(
  messages: readonly Message[],
  width: number,
): number {
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

export const INITIAL_SCROLL_STATE: ScrollState = {
  rawOffset: 0,
  stickyBottom: true,
};

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
export function scrollReducer(
  state: ScrollState,
  action: ScrollAction,
  ctx: ScrollCtx,
): ScrollState {
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
  /** Estimated rows above `startIndex` that scrolled off the top — add `clipTop` for the total hidden row count. */
  hiddenAbove: number;
  /**
   * Rows of the `startIndex` message itself that are scrolled off the top.
   * The caller renders the window inside `<Box marginTop={-clipTop}>` within
   * its `overflow: hidden` viewport, which slices those rows off — Ink clips
   * BOTH edges of an overflow-hidden Box, so this gives line-exact scroll
   * even through a single message taller than the whole viewport.
   */
  clipTop: number;
}

/**
 * Extra estimated rows rendered past the bottom of the viewport (and past the
 * top of a bottom-anchored window). Heights are estimates: a message that
 * renders TALLER than estimated is harmlessly clipped, but one that renders
 * SHORTER would leave a blank gap at the viewport edge — overscan papers over
 * that within `OVERSCAN_ROWS` of cumulative error at negligible layout cost.
 */
const OVERSCAN_ROWS = 8;

/**
 * Which messages fall inside the viewport for the given offset. The window
 * starts at the message CONTAINING `offset` (its in-message remainder comes
 * back as `clipTop` for the caller's negative-margin top clip) and grows
 * message-by-message until it covers the viewport plus a small overscan — the
 * caller's fixed-height `overflow: hidden` Box clips the overshoot at the
 * bottom.
 */
export function computeVisibleWindow(
  rowHeights: readonly number[],
  offset: number,
  viewportHeight: number,
): VisibleWindow {
  if (rowHeights.length === 0)
    return { startIndex: 0, endIndex: 0, hiddenAbove: 0, clipTop: 0 };

  let acc = 0;
  let startIndex = 0;
  for (; startIndex < rowHeights.length; startIndex++) {
    const h = rowHeights[startIndex] ?? 0;
    if (acc + h > offset) break;
    acc += h;
  }
  if (startIndex >= rowHeights.length) startIndex = rowHeights.length - 1;
  const clipTop = Math.max(0, offset - acc);

  // The window must cover the clipped-away top of its first message AND the
  // full viewport below it, plus overscan against estimate error.
  const needed = clipTop + viewportHeight + OVERSCAN_ROWS;
  let shown = 0;
  let endIndex = startIndex;
  for (; endIndex < rowHeights.length; endIndex++) {
    if (shown >= needed) break;
    shown += rowHeights[endIndex] ?? 0;
  }
  return {
    startIndex,
    endIndex: Math.max(endIndex, startIndex + 1),
    hiddenAbove: acc,
    clipTop,
  };
}

export interface BottomWindow {
  /** First message index to render (inclusive; the window always runs to the transcript's end). */
  startIndex: number;
  /**
   * True when the tail is (estimated to be) at least a viewport tall, so the
   * caller should anchor it with `justifyContent: "flex-end"` — the newest
   * output then sits flush against the viewport's bottom edge with REAL
   * rendered heights (Yoga lays the tail out bottom-up and Ink clips whatever
   * overflows the top), immune to estimate error. False while the transcript
   * is still shorter than the viewport: render top-down like a fresh session.
   */
  anchorBottom: boolean;
}

/**
 * Bias toward anchoring: `anchorBottom` flips on when the estimated tail is
 * within this many rows of filling the viewport. The two failure modes are
 * asymmetric — anchoring a slightly-too-short tail leaves a cosmetic gap at
 * the TOP, while top-rendering a slightly-too-tall tail clips the NEWEST
 * lines off the bottom (the exact bug this module exists to fix).
 */
const ANCHOR_BIAS_ROWS = 2;

/**
 * The window for the sticky-bottom (pinned-to-newest) state: the last N
 * messages whose estimated heights cover the viewport plus overscan. Kept
 * separate from {@link computeVisibleWindow} because the bottom-pinned view
 * doesn't scroll by offset at all — it anchors the transcript's real rendered
 * tail to the viewport's bottom edge, so estimate drift can never cut off the
 * newest content.
 */
export function computeBottomWindow(
  rowHeights: readonly number[],
  viewportHeight: number,
): BottomWindow {
  const needed = viewportHeight + OVERSCAN_ROWS;
  let acc = 0;
  let startIndex = rowHeights.length;
  while (startIndex > 0 && acc < needed) {
    startIndex--;
    acc += rowHeights[startIndex] ?? 0;
  }
  return { startIndex, anchorBottom: acc >= viewportHeight - ANCHOR_BIAS_ROWS };
}
