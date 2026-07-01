/**
 * Pure-function coverage for the REPL's scroll-viewport math (see
 * ../scrollback.ts). No React/Ink rendering involved — every function here is
 * exercised as plain data in, data out.
 */
import { describe, it, expect } from "vitest";
import {
  clampOffset,
  scrollBy,
  scrollToBottom,
  scrollToTop,
  visibleWindow,
  onNewItems,
  type ScrollState,
  type ScrollViewport,
} from "../scrollback.js";

const vp = (total: number, height: number): ScrollViewport => ({ total, height });
const state = (overrides: Partial<ScrollState> = {}): ScrollState => ({
  offset: 0,
  stickToBottom: true,
  ...overrides,
});

describe("clampOffset", () => {
  it("never returns negative", () => {
    expect(clampOffset(-5, vp(100, 10))).toBe(0);
    expect(clampOffset(-1, vp(100, 10))).toBe(0);
  });

  it("clamps to 0 when already 0", () => {
    expect(clampOffset(0, vp(100, 10))).toBe(0);
  });

  it("never scrolls beyond total - height", () => {
    expect(clampOffset(1000, vp(100, 10))).toBe(90);
    expect(clampOffset(91, vp(100, 10))).toBe(90);
    expect(clampOffset(90, vp(100, 10))).toBe(90);
  });

  it("passes through in-range values unchanged", () => {
    expect(clampOffset(42, vp(100, 10))).toBe(42);
  });

  it("clamps to 0 when total <= height (nothing to scroll)", () => {
    expect(clampOffset(5, vp(10, 10))).toBe(0);
    expect(clampOffset(5, vp(5, 10))).toBe(0);
    expect(clampOffset(0, vp(0, 10))).toBe(0);
  });

  it("handles a zero-height viewport without going negative", () => {
    expect(clampOffset(5, vp(100, 0))).toBe(5);
    expect(clampOffset(-5, vp(100, 0))).toBe(0);
  });
});

describe("scrollBy", () => {
  it("scrolls up (positive delta) into history and clears stickToBottom", () => {
    const next = scrollBy(state(), 5, vp(100, 10));
    expect(next).toEqual({ offset: 5, stickToBottom: false });
  });

  it("scrolls down (negative delta) toward the newest content", () => {
    const next = scrollBy(state({ offset: 20, stickToBottom: false }), -5, vp(100, 10));
    expect(next).toEqual({ offset: 15, stickToBottom: false });
  });

  it("clamps at the top of history", () => {
    const next = scrollBy(state(), 1000, vp(100, 10));
    expect(next).toEqual({ offset: 90, stickToBottom: false });
  });

  it("clamps at the bottom and sets stickToBottom true when it lands on 0", () => {
    const next = scrollBy(state({ offset: 3, stickToBottom: false }), -100, vp(100, 10));
    expect(next).toEqual({ offset: 0, stickToBottom: true });
  });

  it("sets stickToBottom true exactly when the clamped offset is 0", () => {
    const next = scrollBy(state({ offset: 5, stickToBottom: false }), -5, vp(100, 10));
    expect(next.offset).toBe(0);
    expect(next.stickToBottom).toBe(true);
  });

  it("is a no-op scroll (delta 0) but still recomputes stickToBottom", () => {
    const next = scrollBy(state({ offset: 5, stickToBottom: false }), 0, vp(100, 10));
    expect(next).toEqual({ offset: 5, stickToBottom: false });
  });
});

describe("scrollToBottom", () => {
  it("returns offset 0, stickToBottom true", () => {
    expect(scrollToBottom()).toEqual({ offset: 0, stickToBottom: true });
  });
});

describe("scrollToTop", () => {
  it("returns the maximum offset with stickToBottom false", () => {
    expect(scrollToTop(vp(100, 10))).toEqual({ offset: 90, stickToBottom: false });
  });

  it("returns offset 0 (still not stuck to bottom) when total <= height", () => {
    expect(scrollToTop(vp(5, 10))).toEqual({ offset: 0, stickToBottom: false });
  });
});

describe("visibleWindow", () => {
  const items = Array.from({ length: 25 }, (_, i) => `item-${i}`);

  it("pinned to bottom shows the last `height` items with nothing hidden below", () => {
    const result = visibleWindow(items, state(), 10);
    expect(result.items).toEqual(items.slice(15, 25));
    expect(result.hiddenAbove).toBe(15);
    expect(result.hiddenBelow).toBe(0);
  });

  it("scrolled up shows the correct earlier slice", () => {
    const result = visibleWindow(items, state({ offset: 5, stickToBottom: false }), 10);
    // Window shifts up by 5 from the bottom: ends at 20, starts at 10.
    expect(result.items).toEqual(items.slice(10, 20));
    expect(result.hiddenAbove).toBe(10);
    expect(result.hiddenBelow).toBe(5);
  });

  it("scrolled all the way to the top shows the first `height` items", () => {
    const result = visibleWindow(items, state({ offset: 15, stickToBottom: false }), 10);
    expect(result.items).toEqual(items.slice(0, 10));
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(15);
  });

  it("re-clamps an out-of-range offset instead of producing a bad slice", () => {
    // state.offset (1000) is stale relative to the real item count.
    const result = visibleWindow(items, state({ offset: 1000, stickToBottom: false }), 10);
    expect(result.items).toEqual(items.slice(0, 10));
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(15);
  });

  it("shows everything with zero hidden when total <= height", () => {
    const small = items.slice(0, 4);
    const result = visibleWindow(small, state(), 10);
    expect(result.items).toEqual(small);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
  });

  it("shows everything with zero hidden when total === height exactly", () => {
    const exact = items.slice(0, 10);
    const result = visibleWindow(exact, state(), 10);
    expect(result.items).toEqual(exact);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
  });

  it("handles an empty item list", () => {
    const result = visibleWindow([], state(), 10);
    expect(result.items).toEqual([]);
    expect(result.hiddenAbove).toBe(0);
    expect(result.hiddenBelow).toBe(0);
  });
});

describe("onNewItems", () => {
  it("is a no-op for a non-positive addedCount", () => {
    const s = state({ offset: 5, stickToBottom: false });
    expect(onNewItems(s, 0, vp(100, 10))).toBe(s);
    expect(onNewItems(s, -3, vp(100, 10))).toBe(s);
  });

  it("stays pinned (offset 0) when stickToBottom is true", () => {
    const s = state({ offset: 0, stickToBottom: true });
    // vp.total already reflects the post-append count.
    expect(onNewItems(s, 4, vp(104, 10))).toEqual({ offset: 0, stickToBottom: true });
  });

  it("increases offset by addedCount when scrolled up, so the viewed window doesn't jump", () => {
    const s = state({ offset: 10, stickToBottom: false });
    const next = onNewItems(s, 3, vp(103, 10));
    expect(next).toEqual({ offset: 13, stickToBottom: false });
  });

  it("clamps the increased offset to the new viewport's max", () => {
    const s = state({ offset: 90, stickToBottom: false });
    // total is only 100 (height 10) even after the append, so max offset is 90.
    const next = onNewItems(s, 5, vp(100, 10));
    expect(next).toEqual({ offset: 90, stickToBottom: false });
  });

  it("keeps the scrolled-up view showing the same items after new items arrive", () => {
    const before = Array.from({ length: 25 }, (_, i) => `item-${i}`);
    const scrolled = state({ offset: 10, stickToBottom: false });
    const seenBefore = visibleWindow(before, scrolled, 10);

    // 3 new items appended to the end of history.
    const after = [...before, "item-25", "item-26", "item-27"];
    const nextState = onNewItems(scrolled, 3, vp(after.length, 10));
    const seenAfter = visibleWindow(after, nextState, 10);

    expect(seenAfter.items).toEqual(seenBefore.items);
  });
});
