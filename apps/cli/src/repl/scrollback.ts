/**
 * Scroll-viewport for the REPL's conversation history.
 *
 * The messages region renders on the terminal alternate screen at a fixed
 * height (`rows`), anchored to the newest content. Without a scroll
 * mechanism, everything above the viewport is simply clipped and
 * unreachable. This module gives the REPL a reusable, pure way to scroll
 * backward through the full history — including tool-call and
 * file-change/diff entries — while a turn is idle or running.
 *
 * The state and math below are framework-free and fully unit-testable
 * without rendering anything; `useScrollback` at the bottom is a thin React
 * wrapper that the REPL container wires up to `useInput`.
 */
import { useCallback, useState } from "react";

/**
 * `offset` is how many items the viewport has scrolled UP from the newest
 * item (0 = pinned to the bottom / newest content visible).
 * `stickToBottom` is true exactly when `offset === 0` — it's carried
 * alongside `offset` (rather than derived ad hoc at each call site) so
 * `onNewItems` can tell "the user backed all the way out to the bottom"
 * apart from "the user happens to be at an offset that currently clamps to
 * zero because history is still short."
 */
export interface ScrollState {
  offset: number;
  stickToBottom: boolean;
}

/** The scrollable universe (`total` items) and the visible slice (`height` rows). */
export interface ScrollViewport {
  total: number;
  height: number;
}

/** Clamp `offset` to `[0, max(0, total - height)]` — never negative, never past the top. */
export function clampOffset(offset: number, vp: ScrollViewport): number {
  const max = Math.max(0, vp.total - vp.height);
  if (offset < 0) return 0;
  if (offset > max) return max;
  return offset;
}

/**
 * Scroll by `delta` items. Positive delta scrolls UP (further into history,
 * increasing offset); negative scrolls DOWN toward the newest content. The
 * result is clamped, and `stickToBottom` is recomputed from the clamped
 * offset (true iff it lands back on 0).
 */
export function scrollBy(
  state: ScrollState,
  delta: number,
  vp: ScrollViewport,
): ScrollState {
  const offset = clampOffset(state.offset + delta, vp);
  return { offset, stickToBottom: offset === 0 };
}

/** Jump to the newest content and re-pin the viewport there. */
export function scrollToBottom(): ScrollState {
  return { offset: 0, stickToBottom: true };
}

/** Jump to the oldest content available for the given viewport. */
export function scrollToTop(vp: ScrollViewport): ScrollState {
  return { offset: clampOffset(Number.POSITIVE_INFINITY, vp), stickToBottom: false };
}

/**
 * Slice `items` down to what should render for the current scroll state, plus
 * how many items are hidden above (older) and below (newer) the window —
 * enough for the caller to render "↑ N earlier" / "↓ N newer" affordances.
 *
 * When pinned to the bottom the window is simply the last `height` items.
 * When scrolled up by `offset`, the window shifts up by `offset` items from
 * the bottom. The offset is re-clamped here against the *actual* item count
 * so a stale `state.offset` (e.g. computed against a viewport whose `total`
 * has since changed) never produces an out-of-range slice.
 */
export function visibleWindow<T>(
  items: readonly T[],
  state: ScrollState,
  height: number,
): { items: T[]; hiddenAbove: number; hiddenBelow: number } {
  const total = items.length;
  const offset = clampOffset(state.offset, { total, height });
  const end = total - offset;
  const start = Math.max(0, end - height);
  return {
    items: items.slice(start, end),
    hiddenAbove: start,
    hiddenBelow: total - end,
  };
}

/**
 * Reconcile scroll state when new items arrive (a new message, tool call, or
 * diff is appended). `vp` describes the viewport AFTER the new items have
 * been added — i.e. `vp.total` already includes `addedCount`.
 *
 *   - If the user is pinned to the bottom, stay pinned (offset 0) so new
 *     content streams into view, matching normal chat/REPL behavior.
 *   - If the user has scrolled up into history, INCREASE the offset by
 *     `addedCount` so the content they're currently looking at doesn't jump
 *     out from under them — new items simply extend the history below the
 *     viewport instead of pushing the viewport's contents down.
 */
export function onNewItems(
  state: ScrollState,
  addedCount: number,
  vp: ScrollViewport,
): ScrollState {
  if (addedCount <= 0) return state;
  if (state.stickToBottom) return scrollToBottom();
  const offset = clampOffset(state.offset + addedCount, vp);
  return { offset, stickToBottom: offset === 0 };
}

// ── React wrapper ────────────────────────────────────────────────────────────

/**
 * Minimal structural subset of ink's `Key` type. Defined locally (rather than
 * importing from `ink`) so this module has no ink runtime dependency and stays
 * trivially unit-testable outside of React/Ink.
 */
export interface KeyLike {
  pageUp?: boolean;
  pageDown?: boolean;
  ctrl?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export interface UseScrollbackResult {
  state: ScrollState;
  /** Slice `items` down to the currently visible window for this scroll state. */
  window: <T>(
    items: readonly T[],
  ) => { items: T[]; hiddenAbove: number; hiddenBelow: number };
  /**
   * Feed a key event from `useInput`. Returns `true` if the key was a
   * scrollback key and was consumed (PageUp/PageDown for a full page,
   * Ctrl-U/Ctrl-D for a half page, "g"/"G" to jump to top/bottom), or
   * `false` so the caller can fall through to other key handling.
   */
  handleKey: (input: string, key: KeyLike) => boolean;
  /** Re-pin the viewport to the bottom (e.g. on conversation reset). */
  reset: () => void;
  /** Notify the hook that `added` new items were appended to the history. */
  onItemsChanged: (added: number) => void;
}

/**
 * React hook wrapping the pure scroll math above with `useState`. The page
 * size is derived from `vp.height` (full page = height - 1, half page =
 * floor(height / 2)) so keyboard scrolling always leaves one row of overlap
 * with the previous screen, matching common pager conventions.
 */
export function useScrollback(vp: ScrollViewport): UseScrollbackResult {
  const [state, setState] = useState<ScrollState>(scrollToBottom);

  const page = Math.max(1, vp.height - 1);
  const halfPage = Math.max(1, Math.floor(vp.height / 2));

  const handleKey = useCallback(
    (input: string, key: KeyLike): boolean => {
      if (key.pageUp) {
        setState((s) => scrollBy(s, page, vp));
        return true;
      }
      if (key.pageDown) {
        setState((s) => scrollBy(s, -page, vp));
        return true;
      }
      if (key.ctrl && input === "u") {
        setState((s) => scrollBy(s, halfPage, vp));
        return true;
      }
      if (key.ctrl && input === "d") {
        setState((s) => scrollBy(s, -halfPage, vp));
        return true;
      }
      if (!key.ctrl && input === "g") {
        setState(scrollToTop(vp));
        return true;
      }
      if (!key.ctrl && input === "G") {
        setState(scrollToBottom());
        return true;
      }
      return false;
    },
    [vp, page, halfPage],
  );

  const reset = useCallback(() => setState(scrollToBottom()), []);

  const onItemsChanged = useCallback(
    (added: number) => setState((s) => onNewItems(s, added, vp)),
    [vp],
  );

  const windowFn = useCallback(
    <T,>(items: readonly T[]) => visibleWindow(items, state, vp.height),
    [state, vp.height],
  );

  return { state, window: windowFn, handleKey, reset, onItemsChanged };
}
