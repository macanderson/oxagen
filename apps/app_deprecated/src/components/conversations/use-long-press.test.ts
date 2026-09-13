/**
 * use-long-press.test.ts — unit tests for the useLongPress hook.
 *
 * Tests the pure behaviour: timer scheduling, move-cancel, mouse exclusion,
 * firedRef state, and the context-menu suppression logic.
 *
 * Uses renderHook + fake timers; no DOM rendering required.
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLongPress } from "./use-long-press";

// ---------------------------------------------------------------------------
// Helpers — minimal synthetic events
// ---------------------------------------------------------------------------

function makePointerEvent(
  type: string,
  overrides: Partial<PointerEvent> = {},
): React.PointerEvent {
  return {
    pointerType: "touch",
    clientX: 0,
    clientY: 0,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent;
}

function makeMouseEvent(overrides: Partial<MouseEvent> = {}): React.MouseEvent {
  return {
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.MouseEvent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLongPress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls onLongPress after the default 500 ms delay", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("respects a custom delay", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { delay: 800 }),
    );

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    act(() => vi.advanceTimersByTime(799));
    expect(onLongPress).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("does NOT fire for mouse pointer events", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(
        makePointerEvent("pointerdown", { pointerType: "mouse" }),
      ),
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the timer on pointerUp", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    act(() => result.current.handlers.onPointerUp());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the timer on pointerCancel", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    act(() => result.current.handlers.onPointerCancel());
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels the timer when the pointer moves past the tolerance", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { moveTolerance: 10 }),
    );

    act(() =>
      result.current.handlers.onPointerDown(
        makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }),
      ),
    );
    // Move 11px — exceeds tolerance
    act(() =>
      result.current.handlers.onPointerMove(
        makePointerEvent("pointermove", { clientX: 11, clientY: 0 }),
      ),
    );
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("does NOT cancel when the pointer moves within tolerance", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() =>
      useLongPress(onLongPress, { moveTolerance: 10 }),
    );

    act(() =>
      result.current.handlers.onPointerDown(
        makePointerEvent("pointerdown", { clientX: 0, clientY: 0 }),
      ),
    );
    // Move 5px — within tolerance
    act(() =>
      result.current.handlers.onPointerMove(
        makePointerEvent("pointermove", { clientX: 5, clientY: 0 }),
      ),
    );
    act(() => vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledOnce();
  });

  it("sets firedRef to true when the long-press fires", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    expect(result.current.firedRef.current).toBe(false);

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.firedRef.current).toBe(true);
  });

  it("resets firedRef to false on the next pointerDown", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    // First long-press
    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.firedRef.current).toBe(true);

    // Second pointerDown resets the ref
    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    expect(result.current.firedRef.current).toBe(false);
  });

  it("suppresses the native context menu when firedRef is true", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    act(() =>
      result.current.handlers.onPointerDown(makePointerEvent("pointerdown")),
    );
    act(() => vi.advanceTimersByTime(500));

    const e = makeMouseEvent();
    act(() => result.current.handlers.onContextMenu(e));
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("does NOT suppress the context menu when firedRef is false", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    const e = makeMouseEvent();
    act(() => result.current.handlers.onContextMenu(e));
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("pointerMove is a no-op when no pointerDown start is recorded", () => {
    const onLongPress = vi.fn();
    const { result } = renderHook(() => useLongPress(onLongPress));

    // Should not throw
    expect(() =>
      act(() =>
        result.current.handlers.onPointerMove(
          makePointerEvent("pointermove", { clientX: 999, clientY: 999 }),
        ),
      ),
    ).not.toThrow();
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
