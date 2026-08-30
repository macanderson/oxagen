/**
 * Unit tests for the full-screen transcript viewport's pure scroll math:
 * offset clamping, sticky-bottom auto-follow, line/page/half-page stepping,
 * row estimation, and message-window computation. Pure — no terminal, no
 * timers; see scroll.ts's own doc comment for why. The one exception renders
 * DiffView, because the diff row estimate mirrors a constant that only that
 * component's real output exposes.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import {
  scrollReducer,
  effectiveOffset,
  maxOffsetFor,
  estimateMessageRows,
  totalEstimatedRows,
  computeVisibleWindow,
  computeBottomWindow,
  INITIAL_SCROLL_STATE,
  type ScrollState,
  type ScrollCtx,
} from "../scroll.js";
import { DiffView } from "../diff-view.js";
import { DARK_DIFF_THEME } from "../../tui/terminal-theme.js";
import type { Message } from "../components.js";

function msg(overrides: Partial<Message>): Message {
  return { role: "assistant", content: "", timestamp: 0, ...overrides };
}

describe("estimateMessageRows", () => {
  it("gives compact chips/badges a single row", () => {
    expect(
      estimateMessageRows(msg({ role: "tool", content: "read(a.ts)" }), 80),
    ).toBe(1);
    expect(
      estimateMessageRows(msg({ role: "stage", content: "evaluated" }), 80),
    ).toBe(1);
  });

  it("wraps long text content across multiple rows at the given width", () => {
    const content = "x".repeat(200);
    expect(estimateMessageRows(msg({ content }), 100)).toBe(2);
    expect(estimateMessageRows(msg({ content }), 50)).toBe(4);
  });

  it("counts explicit newlines separately from wrapping", () => {
    const content = "line one\nline two\nline three";
    expect(estimateMessageRows(msg({ content }), 100)).toBe(3);
  });

  it("gives a collapsed terminal accordion one row, an expanded one its output size", () => {
    const collapsed = msg({
      role: "terminal",
      terminalExpanded: false,
      terminalRun: {
        id: 1,
        command: "ls",
        output: "a\nb\nc",
        status: "exited",
        startedAt: 0,
      },
    });
    expect(estimateMessageRows(collapsed, 80)).toBe(1);

    const expanded = msg({
      role: "terminal",
      terminalExpanded: true,
      terminalRun: {
        id: 1,
        command: "ls",
        output: "a\nb\nc",
        status: "exited",
        startedAt: 0,
      },
    });
    expect(estimateMessageRows(expanded, 80)).toBeGreaterThan(1);
  });

  it("sizes a diff by its real rendered height: lines + header + marginY", () => {
    const shortDiff = msg({ role: "diff", diff: "line1\nline2\nline3" });
    expect(estimateMessageRows(shortDiff, 80)).toBe(6); // 3 lines + header(1) + marginY(2)

    // A large diff must be estimated at its FULL rendered height (DiffView
    // renders every line up to its 500-line cap) — the old 60-row cap made
    // scroll positions above a big diff unreachable.
    const bigDiff = msg({
      role: "diff",
      diff: Array.from({ length: 200 }, () => "x").join("\n"),
    });
    expect(estimateMessageRows(bigDiff, 80)).toBe(203);

    // Past DiffView's own truncation cap, the estimate tracks the cap + its
    // one-line "… more lines" note instead of growing unboundedly.
    const hugeDiff = msg({
      role: "diff",
      diff: Array.from({ length: 800 }, () => "x").join("\n"),
    });
    expect(estimateMessageRows(hugeDiff, 80)).toBe(500 + 1 + 3);
  });

  it("caps a user prompt at its 4-line preview + expand hint (MessageView truncates it)", () => {
    const longPrompt = msg({
      role: "user",
      content: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"),
    });
    expect(estimateMessageRows(longPrompt, 80)).toBe(5);
    const shortPrompt = msg({ role: "user", content: "one\ntwo" });
    expect(estimateMessageRows(shortPrompt, 80)).toBe(2);
  });

  it("gives a summary card a fixed small height and a replay trace a fixed tall one", () => {
    expect(
      estimateMessageRows(
        msg({
          summary: {
            complete: true,
            filesTouched: [],
            costUsd: 0,
            judged: false,
          },
        }),
        80,
      ),
    ).toBe(6);
  });

  it("never returns zero even for empty content", () => {
    expect(
      estimateMessageRows(msg({ content: "" }), 80),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("estimateMessageRows — diff cap tracks DiffView's real truncation point", () => {
  // scroll.ts holds its own DIFF_VIEW_MAX_LINES copy of diff-view.tsx's private
  // DEFAULT_MAX_LINES, and neither constant is exported. Nothing links them but
  // these two assertions: they observe where DiffView (rendered with NO explicit
  // maxLines, exactly as DiffMessage renders it) actually starts truncating, and
  // fail loudly if either side moves independently. Drift here silently makes
  // scroll positions above a large diff unreachable.
  const diffOf = (lineCount: number): string =>
    Array.from({ length: lineCount }, (_, i) => `+line ${i}`).join("\n");
  const truncates = (lineCount: number): boolean => {
    const { lastFrame, unmount } = render(
      createElement(DiffView, {
        diff: diffOf(lineCount),
        theme: DARK_DIFF_THEME,
      }),
    );
    const truncated = (lastFrame() ?? "").includes("more lines");
    unmount();
    return truncated;
  };

  it("renders a diff of exactly the estimated cap in full", () => {
    // 500 lines estimate to cap + header(1) + marginY(2) with no truncation note.
    expect(
      estimateMessageRows(msg({ role: "diff", diff: diffOf(500) }), 80),
    ).toBe(503);
    expect(truncates(500)).toBe(false);
  });

  it("truncates one line past the cap, exactly where the estimate adds its note row", () => {
    // 501 lines: DiffView renders 500 + a "… more lines" row, and the estimate
    // stops growing at cap + note + header + marginY.
    expect(
      estimateMessageRows(msg({ role: "diff", diff: diffOf(501) }), 80),
    ).toBe(504);
    expect(truncates(501)).toBe(true);
  });
});

describe("totalEstimatedRows", () => {
  it("sums row estimates across the transcript", () => {
    const messages = [
      msg({ role: "tool" }),
      msg({ role: "stage" }),
      msg({ content: "hi" }),
    ];
    expect(totalEstimatedRows(messages, 80)).toBe(3);
  });

  it("returns 0 for an empty transcript", () => {
    expect(totalEstimatedRows([], 80)).toBe(0);
  });
});

describe("maxOffsetFor / effectiveOffset", () => {
  it("max offset is 0 when content fits entirely in the viewport", () => {
    expect(maxOffsetFor({ totalLines: 10, viewportHeight: 20 })).toBe(0);
  });

  it("max offset is content minus viewport when content overflows", () => {
    expect(maxOffsetFor({ totalLines: 100, viewportHeight: 20 })).toBe(80);
  });

  it("sticky-bottom always resolves to the current max, tracking growing content", () => {
    const state: ScrollState = { rawOffset: 0, stickyBottom: true };
    expect(
      effectiveOffset(state, { totalLines: 100, viewportHeight: 20 }),
    ).toBe(80);
    // Content grew (more streamed in) — sticky-bottom follows without a dispatch.
    expect(
      effectiveOffset(state, { totalLines: 140, viewportHeight: 20 }),
    ).toBe(120);
  });

  it("a non-sticky raw offset clamps into [0, max]", () => {
    const tooHigh: ScrollState = { rawOffset: 999, stickyBottom: false };
    expect(
      effectiveOffset(tooHigh, { totalLines: 100, viewportHeight: 20 }),
    ).toBe(80);
    const negative: ScrollState = { rawOffset: -5, stickyBottom: false };
    expect(
      effectiveOffset(negative, { totalLines: 100, viewportHeight: 20 }),
    ).toBe(0);
  });
});

describe("scrollReducer", () => {
  const ctx: ScrollCtx = { totalLines: 100, viewportHeight: 20 }; // max offset 80

  it("line-up/line-down move by exactly one row and clear/re-engage sticky-bottom", () => {
    const oneUp = scrollReducer(INITIAL_SCROLL_STATE, { type: "line-up" }, ctx);
    expect(oneUp).toEqual({ rawOffset: 79, stickyBottom: false });

    const backAtBottom = scrollReducer(oneUp, { type: "line-down" }, ctx);
    expect(backAtBottom).toEqual({ rawOffset: 80, stickyBottom: true });
  });

  it("page-up/page-down move by a full viewport height", () => {
    const up = scrollReducer(INITIAL_SCROLL_STATE, { type: "page-up" }, ctx);
    expect(up).toEqual({ rawOffset: 60, stickyBottom: false });
    const down = scrollReducer(up, { type: "page-down" }, ctx);
    expect(down).toEqual({ rawOffset: 80, stickyBottom: true });
  });

  it("half-up/half-down move by half a viewport height, rounded up", () => {
    const ctxOdd: ScrollCtx = { totalLines: 100, viewportHeight: 21 }; // half = 11 (ceil)
    const state: ScrollState = { rawOffset: 50, stickyBottom: false };
    const up = scrollReducer(state, { type: "half-up" }, ctxOdd);
    expect(up.rawOffset).toBe(39);
    const down = scrollReducer(up, { type: "half-down" }, ctxOdd);
    expect(down.rawOffset).toBe(50);
  });

  it("clamps at the top — page-up from near the top never goes negative", () => {
    const near: ScrollState = { rawOffset: 5, stickyBottom: false };
    const result = scrollReducer(near, { type: "page-up" }, ctx);
    expect(result).toEqual({ rawOffset: 0, stickyBottom: false });
  });

  it("clamps at the bottom — page-down past the max lands exactly on it and re-engages sticky-bottom", () => {
    const near: ScrollState = { rawOffset: 75, stickyBottom: false };
    const result = scrollReducer(near, { type: "page-down" }, ctx);
    expect(result).toEqual({ rawOffset: 80, stickyBottom: true });
  });

  it("home jumps to the top and clears sticky-bottom", () => {
    const result = scrollReducer(INITIAL_SCROLL_STATE, { type: "home" }, ctx);
    expect(result).toEqual({ rawOffset: 0, stickyBottom: false });
  });

  it("end jumps to the bottom and engages sticky-bottom", () => {
    const atTop: ScrollState = { rawOffset: 0, stickyBottom: false };
    const result = scrollReducer(atTop, { type: "end" }, ctx);
    expect(result).toEqual({ rawOffset: 80, stickyBottom: true });
  });

  it("when content fits entirely in the viewport, every action lands at offset 0 and stays sticky", () => {
    const smallCtx: ScrollCtx = { totalLines: 5, viewportHeight: 20 };
    const result = scrollReducer(
      INITIAL_SCROLL_STATE,
      { type: "line-up" },
      smallCtx,
    );
    expect(result).toEqual({ rawOffset: 0, stickyBottom: true });
  });

  it("is a pure function — never mutates the input state object", () => {
    const state: ScrollState = { rawOffset: 10, stickyBottom: false };
    const snapshot = { ...state };
    scrollReducer(state, { type: "line-down" }, ctx);
    expect(state).toEqual(snapshot);
  });
});

describe("computeVisibleWindow", () => {
  it("returns an empty window for an empty transcript", () => {
    expect(computeVisibleWindow([], 0, 20)).toEqual({
      startIndex: 0,
      endIndex: 0,
      hiddenAbove: 0,
      clipTop: 0,
    });
  });

  it("at offset 0, starts at the first message with nothing hidden above and no top clip", () => {
    const heights = [1, 3, 2, 5];
    const win = computeVisibleWindow(heights, 0, 4);
    expect(win.startIndex).toBe(0);
    expect(win.hiddenAbove).toBe(0);
    expect(win.clipTop).toBe(0);
  });

  it("finds the message containing the offset and splits it into hiddenAbove + clipTop", () => {
    const heights = [2, 3, 4, 1]; // cumulative starts: 0, 2, 5, 9
    // offset 6 falls inside message index 2 (rows 5..9), one row into it.
    const win = computeVisibleWindow(heights, 6, 3);
    expect(win.startIndex).toBe(2);
    expect(win.hiddenAbove).toBe(5);
    expect(win.clipTop).toBe(1);
  });

  it("an offset landing exactly on a message boundary has zero clipTop", () => {
    const heights = [2, 3, 4, 1];
    const win = computeVisibleWindow(heights, 5, 3);
    expect(win.startIndex).toBe(2);
    expect(win.clipTop).toBe(0);
  });

  it("grows the window until it covers at least the viewport height", () => {
    const heights = [1, 1, 1, 1, 1, 1, 1, 1];
    const win = computeVisibleWindow(heights, 0, 3);
    // Needs at least 3 messages' worth of rows (1 each) to cover height 3.
    expect(win.endIndex - win.startIndex).toBeGreaterThanOrEqual(3);
  });

  it("covers clipTop + viewport when the offset starts mid-message", () => {
    const heights = [
      10, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    ];
    // offset 8 → clipTop 8 of the first message; the window must still cover
    // 8 (clipped) + 4 (viewport) rows before stopping, not just 4.
    const win = computeVisibleWindow(heights, 8, 4);
    expect(win.startIndex).toBe(0);
    expect(win.clipTop).toBe(8);
    let covered = 0;
    for (let i = win.startIndex; i < win.endIndex; i++)
      covered += heights[i] ?? 0;
    expect(covered).toBeGreaterThanOrEqual(8 + 4);
  });

  it("scrolls line-by-line THROUGH a single message taller than the viewport via clipTop", () => {
    const heights = [50];
    for (const offset of [0, 1, 10, 46]) {
      const win = computeVisibleWindow(heights, offset, 4);
      expect(win.startIndex).toBe(0);
      expect(win.endIndex).toBe(1);
      expect(win.clipTop).toBe(offset);
    }
  });

  it("clamps a beyond-range offset to the last message rather than throwing", () => {
    const heights = [1, 1, 1];
    const win = computeVisibleWindow(heights, 999, 3);
    expect(win.startIndex).toBe(2);
  });
});

describe("computeBottomWindow", () => {
  it("includes the whole transcript and renders top-down while it's shorter than the viewport", () => {
    const win = computeBottomWindow([1, 1, 1], 20);
    expect(win.startIndex).toBe(0);
    expect(win.anchorBottom).toBe(false);
  });

  it("anchors to the bottom once the tail fills the viewport, windowing only the tail", () => {
    const heights = Array.from({ length: 40 }, () => 2); // 80 rows total
    const win = computeBottomWindow(heights, 10);
    expect(win.anchorBottom).toBe(true);
    expect(win.startIndex).toBeGreaterThan(0);
    // The included tail covers viewport + overscan, and no more than one
    // message past that (the loop stops at the first message crossing it).
    let acc = 0;
    for (let i = win.startIndex; i < heights.length; i++)
      acc += heights[i] ?? 0;
    expect(acc).toBeGreaterThanOrEqual(10);
  });

  it("anchors even when estimates fall just short of the viewport (bias toward never clipping the newest lines)", () => {
    // 19 estimated rows in a 20-row viewport: within the bias margin, so the
    // caller flex-ends — a real height 1-2 rows past the estimate must land
    // flush at the bottom, not clipped off it.
    const win = computeBottomWindow([19], 20);
    expect(win.anchorBottom).toBe(true);
  });

  it("returns an empty top-down window for an empty transcript", () => {
    expect(computeBottomWindow([], 10)).toEqual({
      startIndex: 0,
      anchorBottom: false,
    });
  });
});
