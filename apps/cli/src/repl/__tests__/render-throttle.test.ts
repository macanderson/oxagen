/**
 * Unit tests for the per-token transcript re-render throttle (render-throttle.ts).
 *
 * Pure setTimeout-based coalescing — no Ink, no React, no real sleeps. Every
 * test drives fake timers explicitly so it's deterministic and instant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRenderThrottle } from "../render-throttle.js";

describe("createRenderThrottle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid schedule() calls within one frame window into exactly one commit", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v), {
      frameMs: 33,
    });

    // 20 rapid-fire schedule() calls, each a few ms apart, all within one
    // 33ms frame window — simulates a burst of streamed tokens.
    let latest = 0;
    for (let i = 1; i <= 20; i++) {
      latest = i;
      throttle.schedule(() => latest);
      vi.advanceTimersByTime(1);
    }

    expect(commits).toHaveLength(0); // frame window (33ms) hasn't elapsed yet

    // Let the armed timer fire.
    vi.advanceTimersByTime(33);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toBe(20); // the LATEST value at flush time, not the first
  });

  it("commits the latest state at flush time, not a snapshot captured at schedule time", () => {
    const commits: string[] = [];
    const throttle = createRenderThrottle<string>((v) => commits.push(v), {
      frameMs: 33,
    });

    // The closure passed to schedule() reads a mutable variable that keeps
    // changing between schedule() and the timer firing — mirrors `turn`
    // mutating between interactive.tsx's render() calls. Because `getLatest`
    // is invoked (not snapshotted) at flush time, the timer must observe
    // whatever `mutable` holds THEN, even though the last `schedule()` call
    // happened while it was still "b".
    let mutable = "a";
    throttle.schedule(() => mutable);
    mutable = "b";
    throttle.schedule(() => mutable);
    mutable = "c"; // no further schedule() call — timer is already armed

    vi.advanceTimersByTime(33);

    expect(commits).toEqual(["c"]); // getLatest() re-read live state at fire time, not a stale snapshot
  });

  it("flush() commits immediately and cancels any pending timer", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v), {
      frameMs: 33,
    });

    throttle.schedule(() => 1);
    vi.advanceTimersByTime(10); // still inside the frame window — nothing committed yet

    throttle.flush(() => 42);
    expect(commits).toEqual([42]);

    // Advancing past where the original timer would have fired must NOT
    // produce a second, stale commit.
    vi.advanceTimersByTime(50);
    expect(commits).toEqual([42]);
  });

  it("flush() with no pending schedule still commits exactly once", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v));

    throttle.flush(() => 7);
    expect(commits).toEqual([7]);
  });

  it("cancel() prevents a pending commit from ever firing", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v), {
      frameMs: 33,
    });

    throttle.schedule(() => 1);
    throttle.cancel();

    vi.advanceTimersByTime(100);
    expect(commits).toHaveLength(0);
  });

  it("cancel() is idempotent and safe with no pending timer", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v));

    expect(() => {
      throttle.cancel();
      throttle.cancel();
    }).not.toThrow();
    expect(commits).toHaveLength(0);
  });

  it("a schedule() after a flush arms a fresh timer for the next frame", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v), {
      frameMs: 33,
    });

    throttle.schedule(() => 1);
    throttle.flush(() => 1);
    expect(commits).toEqual([1]);

    throttle.schedule(() => 2);
    vi.advanceTimersByTime(33);
    expect(commits).toEqual([1, 2]);
  });

  it("defaults to a ~33ms (30fps) frame when frameMs is not given", () => {
    const commits: number[] = [];
    const throttle = createRenderThrottle<number>((v) => commits.push(v));

    throttle.schedule(() => 1);
    vi.advanceTimersByTime(32);
    expect(commits).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(commits).toHaveLength(1);
  });
});
