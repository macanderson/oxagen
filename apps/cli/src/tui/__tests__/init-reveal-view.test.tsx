/**
 * Tests for the OXAGEN reveal Ink view. The frame sequencing itself is
 * covered against the pure function in init-reveal.test.ts — this confirms
 * the component actually draws it, holds on completion, and calls onDone.
 * Uses tiny real-timer overrides (tickMs/holdMs) rather than fake timers —
 * this codebase's Ink tests don't fight Ink's renderer with vi.useFakeTimers
 * (see repl/__tests__/components.test.tsx); commands/init.ts's own
 * `_duckdbPath` test seam is the same "override the constant for tests"
 * convention applied here.
 *
 * Positive assertions poll with a deadline rather than sleeping a fixed
 * interval — a loaded CI runner can take far longer than a "generous" sleep
 * to run all the reveal ticks, and fixed sleeps were flaking there.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { InitRevealView } from "../init-reveal-view.js";
import { WORDMARK } from "../banner.js";

/**
 * Poll until `cond` holds (or the deadline passes — the caller's assertion then
 * reports the real failure). The reveal advances on REAL 1ms timers, so its
 * wall-clock completion time balloons when the host is CPU-starved — e.g. the
 * full `pnpm gate`, which runs every package's vitest concurrently across all
 * cores. A 4s deadline flaked there (observed ~4.6–5.2s) even though the reveal
 * completes in ~350ms in isolation; the deadline is generous so a saturated
 * runner still passes, while the happy path returns the instant `cond` holds.
 */
async function until(
  cond: () => boolean,
  timeoutMs = 20000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("InitRevealView", () => {
  it("starts blank and draws the wordmark over time", async () => {
    const { lastFrame, unmount } = render(
      <InitRevealView onDone={() => {}} tickMs={1} holdMs={1000} />,
    );
    expect(lastFrame() ?? "").not.toContain("█");

    await until(() => (lastFrame() ?? "").includes("█"));
    expect(lastFrame() ?? "").toContain("█");
    unmount();
  });

  it("calls onDone once the reveal completes and holds", async () => {
    const onDone = vi.fn();
    const { unmount } = render(
      <InitRevealView onDone={onDone} tickMs={1} holdMs={5} />,
    );

    await until(() => onDone.mock.calls.length >= 1);
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does not call onDone before the reveal completes", async () => {
    const onDone = vi.fn();
    const { unmount } = render(
      <InitRevealView onDone={onDone} tickMs={1000} holdMs={1000} />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(onDone).not.toHaveBeenCalled();
    unmount();
  });

  it("shows the completed wordmark and a ready marker once fully revealed", async () => {
    const { lastFrame, unmount } = render(
      <InitRevealView onDone={() => {}} tickMs={1} holdMs={1000} />,
    );
    await until(() => {
      const f = lastFrame() ?? "";
      return WORDMARK.every((line) => f.includes(line)) && f.includes("ready");
    });
    const frame = lastFrame() ?? "";
    for (const line of WORDMARK) {
      expect(frame).toContain(line);
    }
    expect(frame).toContain("ready");
    unmount();
  });
});
