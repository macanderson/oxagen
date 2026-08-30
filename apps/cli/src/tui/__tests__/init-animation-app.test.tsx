/**
 * Tests for the composed init-animation Ink app: does it show the live phase
 * readout as InitProgressEvents arrive, and does it hand off to the OXAGEN
 * reveal (and eventually call onReady) the moment domain inference resolves —
 * regardless of whether it resolved via "done" or "skipped".
 *
 * Ink's own re-render (turning a dispatched state update into a new
 * lastFrame()) lands a tick after the emitter callback runs, so every
 * emit-then-assert here polls via until() first — the subscription itself
 * (the useEffect that calls emitter.on) is attached synchronously within
 * render(), as the "stops listening after unmount" test below confirms.
 */
import { describe, it, expect, vi } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { EventEmitter } from "node:events";
import { InitAnimationApp } from "../init-animation-app.js";
import type { InitProgressEvent } from "../../commands/init.js";

// Fast, deterministic timers throughout — see init-reveal-view.test.tsx for
// why this codebase's Ink tests use tiny real-timer overrides over fake timers.
const FAST = {
  gameTickMs: 1000,
  spinnerTickMs: 1000,
  revealTickMs: 1,
  revealHoldMs: 5,
};

/**
 * Poll until `cond` holds (or the deadline passes — the caller's assertion
 * then reports the real failure). Positive assertions poll instead of using
 * fixed flush() sleeps: a loaded CI runner can take far longer than a
 * "generous" sleep to land Ink's re-render, and fixed sleeps were flaking.
 */
async function until(
  cond: () => boolean,
  timeoutMs = 4000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("InitAnimationApp", () => {
  it("shows the phase label as progress events arrive", async () => {
    const emitter = new EventEmitter();
    const onReady = vi.fn();
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={onReady}
        width={30}
        {...FAST}
      />,
    );

    emitter.emit("progress", {
      phase: "graph",
      status: "start",
    } satisfies InitProgressEvent);
    await until(() => (lastFrame() ?? "").includes("Building code graph…"));
    expect(lastFrame() ?? "").toContain("Building code graph…");

    emitter.emit("progress", {
      phase: "graph",
      status: "progress",
      filesDone: 5,
      filesTotal: 10,
    } satisfies InitProgressEvent);
    await until(() => (lastFrame() ?? "").includes("5/10 files"));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5/10 files");
    expect(frame).toContain("█");

    unmount();
  });

  it("throttles rapid progress ticks but always renders the final (100%) one", async () => {
    // A big repo emits one progress event per file — hundreds of dispatches.
    // The reducer throttles intermediate redraws (~24 max) but must never
    // drop the LAST tick, or the bar would visibly stick below 100% even
    // though the real build finished.
    const emitter = new EventEmitter();
    const total = 200;
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={() => {}}
        width={30}
        {...FAST}
      />,
    );

    for (let done = 1; done <= total; done++) {
      emitter.emit("progress", {
        phase: "graph",
        status: "progress",
        filesDone: done,
        filesTotal: total,
      } satisfies InitProgressEvent);
    }
    await until(() => (lastFrame() ?? "").includes(`${total}/${total} files`));

    expect(lastFrame() ?? "").toContain(`${total}/${total} files`);
    unmount();
  });

  it("still shows the game while working", () => {
    const emitter = new EventEmitter();
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={() => {}}
        width={30}
        {...FAST}
      />,
    );
    expect(/[▲◆●]/.test(lastFrame() ?? "")).toBe(true);
    unmount();
  });

  it("hands off to the OXAGEN reveal when domains resolves as done, and eventually calls onReady", async () => {
    const emitter = new EventEmitter();
    const onReady = vi.fn();
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={onReady}
        width={30}
        {...FAST}
      />,
    );

    emitter.emit("progress", {
      phase: "domains",
      status: "done",
      domains: [{ name: "billing", files: 3 }],
    } satisfies InitProgressEvent);
    await until(() => !/[▲◆●]/.test(lastFrame() ?? ""));

    expect(lastFrame() ?? "").not.toMatch(/[▲◆●]/); // game is gone, reveal is up

    await until(() => onReady.mock.calls.length >= 1);
    expect(onReady).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("hands off to the OXAGEN reveal when domains resolves as skipped (no AI credential)", async () => {
    const emitter = new EventEmitter();
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={() => {}}
        width={30}
        {...FAST}
      />,
    );

    emitter.emit("progress", {
      phase: "domains",
      status: "skipped",
    } satisfies InitProgressEvent);
    await until(() => !/[▲◆●]/.test(lastFrame() ?? ""));
    expect(lastFrame() ?? "").not.toMatch(/[▲◆●]/);
    unmount();
  });

  it("does not reveal on domains:start — the phase has only just begun", async () => {
    const emitter = new EventEmitter();
    const { lastFrame, unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={() => {}}
        width={30}
        {...FAST}
      />,
    );

    emitter.emit("progress", {
      phase: "domains",
      status: "start",
      totalFiles: 20,
    } satisfies InitProgressEvent);
    await until(() => (lastFrame() ?? "").includes("Inferring domains…"));

    expect(lastFrame() ?? "").toContain("Inferring domains…");
    expect(/[▲◆●]/.test(lastFrame() ?? "")).toBe(true); // still the game, not the reveal
    unmount();
  });

  it("stops listening after unmount", () => {
    const emitter = new EventEmitter();
    const { unmount } = render(
      <InitAnimationApp
        emitter={emitter}
        onReady={() => {}}
        width={30}
        {...FAST}
      />,
    );
    expect(emitter.listenerCount("progress")).toBeGreaterThan(0);
    unmount();
    expect(emitter.listenerCount("progress")).toBe(0);
  });
});
