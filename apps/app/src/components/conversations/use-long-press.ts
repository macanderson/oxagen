"use client";
import { useCallback, useEffect, useRef } from "react";

export interface LongPressBinding {
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: () => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
  /**
   * Set true the instant a long-press fires. The consumer reads it in an
   * onClickCapture to swallow the click that touch devices emit on pointer-up,
   * so a long-press opens the menu without also navigating the row's link.
   */
  firedRef: React.RefObject<boolean>;
}

/**
 * Long-press detection for touch / pen. Mouse is intentionally ignored — on
 * desktop the row uses double-click and right-click instead — so a held mouse
 * button never opens the menu. Cancels if the pointer moves past the tolerance
 * (the user is scrolling the list, not pressing a row).
 */
export function useLongPress(
  onLongPress: () => void,
  opts: { delay?: number; moveTolerance?: number } = {},
): LongPressBinding {
  const { delay = 500, moveTolerance = 10 } = opts;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    start.current = null;
  }, []);

  // A pending press must not outlive the row. Without this, deleting or
  // archiving a conversation mid-press leaves the timer to fire `onLongPress`
  // against an unmounted component.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return;
      firedRef.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        firedRef.current = true;
        onLongPress();
        clear();
      }, delay);
    },
    [delay, onLongPress, clear],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!start.current) return;
      const dx = Math.abs(e.clientX - start.current.x);
      const dy = Math.abs(e.clientY - start.current.y);
      if (dx > moveTolerance || dy > moveTolerance) clear();
    },
    [moveTolerance, clear],
  );

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    // Suppress the native long-press menu on touch so only our menu shows.
    if (firedRef.current) e.preventDefault();
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clear,
      onPointerCancel: clear,
      onContextMenu,
    },
    firedRef,
  };
}
