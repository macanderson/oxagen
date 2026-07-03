/**
 * Tests for the OXAGEN reveal Ink view. The frame sequencing itself is
 * covered against the pure function in init-reveal.test.ts — this confirms
 * the component actually draws it, holds on completion, and calls onDone.
 * Uses tiny real-timer overrides (tickMs/holdMs) rather than fake timers —
 * this codebase's Ink tests don't fight Ink's renderer with vi.useFakeTimers
 * (see repl/__tests__/components.test.tsx); commands/init.ts's own
 * `_duckdbPath` test seam is the same "override the constant for tests"
 * convention applied here.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { InitRevealView } from "../init-reveal-view.js";
import { WORDMARK } from "../banner.js";

describe("InitRevealView", () => {
  it("starts blank and draws the wordmark over time", async () => {
    const { lastFrame, unmount } = render(
      <InitRevealView onDone={() => {}} tickMs={1} holdMs={1000} />,
    );
    expect(lastFrame() ?? "").not.toContain("█");

    await new Promise((r) => setTimeout(r, 200));
    expect(lastFrame() ?? "").toContain("█");
    unmount();
  });

  it("calls onDone once the reveal completes and holds", async () => {
    const onDone = vi.fn();
    const { unmount } = render(<InitRevealView onDone={onDone} tickMs={1} holdMs={5} />);

    await new Promise((r) => setTimeout(r, 500));
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not call onDone before the reveal completes", async () => {
    const onDone = vi.fn();
    const { unmount } = render(<InitRevealView onDone={onDone} tickMs={1000} holdMs={1000} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(onDone).not.toHaveBeenCalled();
    unmount();
  });

  it("shows the completed wordmark and a ready marker once fully revealed", async () => {
    const { lastFrame, unmount } = render(
      <InitRevealView onDone={() => {}} tickMs={1} holdMs={1000} />,
    );
    await new Promise((r) => setTimeout(r, 200));
    const frame = lastFrame() ?? "";
    for (const line of WORDMARK) {
      expect(frame).toContain(line);
    }
    expect(frame).toContain("ready");
    unmount();
  });
});
