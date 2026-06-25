'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clampToViewport,
  getAgentPanelPosition,
  setAgentPanelPosition,
} from '@/lib/agent-panel-storage';

const DEFAULT_PANEL_WIDTH = 480;
const DEFAULT_PANEL_HEIGHT = 600;

/**
 * Hook to manage the position state and drag events of the draggable agent panel.
 * Persists position to localStorage scoped by workspace.
 * Clamps position to viewport bounds on every update.
 *
 * @param workspaceId - The workspace ID to scope position storage
 * @returns Object containing position state, setter, and pointer event handler
 */
export function useAgentPanelPosition(workspaceId: string) {
  // Initialize position from localStorage or use defaults
  const [x, setX] = useState<number>(0);
  const [y, setY] = useState<number>(0);
  const [isInitialized, setIsInitialized] = useState(false);

  // Track drag state
  const isDraggingRef = useRef(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  // Initialize position from localStorage on mount
  useEffect(() => {
    const stored = getAgentPanelPosition(workspaceId);
    if (stored) {
      setX(stored.x);
      setY(stored.y);
    } else {
      // Use default position (bottom-right area)
      setX(window.innerWidth - DEFAULT_PANEL_WIDTH - 20);
      setY(window.innerHeight - DEFAULT_PANEL_HEIGHT - 20);
    }
    setIsInitialized(true);
  }, [workspaceId]);

  /**
   * Update position and persist to localStorage.
   * Clamps coordinates to viewport bounds.
   */
  const setPosition = useCallback(
    (newX: number, newY: number) => {
      const clamped = clampToViewport(
        newX,
        newY,
        DEFAULT_PANEL_WIDTH,
        DEFAULT_PANEL_HEIGHT,
      );
      setX(clamped.x);
      setY(clamped.y);
      setAgentPanelPosition(workspaceId, clamped.x, clamped.y);
    },
    [workspaceId],
  );

  /**
   * Handle pointer down events for drag initiation.
   * Only initiates drag if the drag handle (data-agent-panel-header) is clicked.
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Check if the click target or its parent has the drag handle attribute
      const target = e.target as HTMLElement;
      const dragHandle = target.closest('[data-agent-panel-header]');

      if (!dragHandle) {
        return;
      }

      isDraggingRef.current = true;
      dragOffsetRef.current = {
        x: e.clientX - x,
        y: e.clientY - y,
      };

      // Add pointer move and up listeners
      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (!isDraggingRef.current) return;

        const newX = moveEvent.clientX - dragOffsetRef.current.x;
        const newY = moveEvent.clientY - dragOffsetRef.current.y;

        setPosition(newX, newY);
      };

      const handlePointerUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
      };

      document.addEventListener('pointermove', handlePointerMove);
      document.addEventListener('pointerup', handlePointerUp);
    },
    [x, y, setPosition],
  );

  return {
    x,
    y,
    setPosition,
    onPointerDown,
    isInitialized,
  };
}
