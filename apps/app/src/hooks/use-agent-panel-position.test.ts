// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentPanelPosition } from './use-agent-panel-position';
import * as storage from '@/lib/agent-panel-storage';

vi.mock('@/lib/agent-panel-storage', () => ({
  getAgentPanelPosition: vi.fn(),
  setAgentPanelPosition: vi.fn(),
  clampToViewport: vi.fn((x, y) => ({ x, y })),
}));

describe('useAgentPanelPosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default window dimensions for testing
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(window, 'innerHeight', {
      writable: true,
      configurable: true,
      value: 768,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with stored position when available', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 100, y: 200 });

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    // isInitialized becomes true after useEffect runs
    expect(result.current.isInitialized).toBe(true);
    expect(result.current.x).toBe(100);
    expect(result.current.y).toBe(200);
  });

  it('initializes with default position when no stored position exists', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue(null);

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    // After effect runs, should have initialized with default position
    expect(result.current.isInitialized).toBe(true);
    // Default position is near bottom-right
    expect(result.current.x).toBe(1024 - 480 - 20); // window.innerWidth - DEFAULT_PANEL_WIDTH - 20
    expect(result.current.y).toBe(768 - 600 - 20); // window.innerHeight - DEFAULT_PANEL_HEIGHT - 20
  });

  it('stores workspace ID for correct scoping', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 50, y: 75 });

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    expect(result.current.isInitialized).toBe(true);
    expect(vi.mocked(storage.getAgentPanelPosition)).toHaveBeenCalledWith('workspace-1');
  });

  it('updates position via setPosition and persists to localStorage', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 0, y: 0 });
    vi.mocked(storage.clampToViewport).mockReturnValue({ x: 150, y: 250 });

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    act(() => {
      result.current.setPosition(150, 250);
    });

    expect(vi.mocked(storage.clampToViewport)).toHaveBeenCalledWith(150, 250, 480, 600);
    expect(vi.mocked(storage.setAgentPanelPosition)).toHaveBeenCalledWith('workspace-1', 150, 250);
  });

  it('clamps position to viewport bounds when setting position', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 0, y: 0 });
    vi.mocked(storage.clampToViewport).mockReturnValue({ x: 500, y: 300 });

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    act(() => {
      result.current.setPosition(2000, 2000);
    });

    expect(vi.mocked(storage.clampToViewport)).toHaveBeenCalledWith(2000, 2000, 480, 600);
    expect(vi.mocked(storage.setAgentPanelPosition)).toHaveBeenCalledWith('workspace-1', 500, 300);
  });

  it('handles pointer down without drag handle returns early', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 100, y: 100 });

    const { result } = renderHook(() => useAgentPanelPosition('workspace-1'));

    const mockElement = document.createElement('div');
    const event = new PointerEvent('pointerdown', {
      clientX: 200,
      clientY: 200,
      bubbles: true,
    });
    Object.defineProperty(event, 'target', { value: mockElement, enumerable: true });

    act(() => {
      result.current.onPointerDown(event as any);
    });

    // Should not call setPosition since there's no drag handle
    expect(vi.mocked(storage.setAgentPanelPosition)).not.toHaveBeenCalled();
  });

  it('returns memoized setPosition that remains stable across renders', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 0, y: 0 });

    const { result, rerender } = renderHook(() => useAgentPanelPosition('workspace-1'));
    const firstSetPosition = result.current.setPosition;

    rerender();

    const secondSetPosition = result.current.setPosition;
    expect(firstSetPosition).toBe(secondSetPosition);
  });

  it('uses different workspace IDs for different instances', () => {
    vi.mocked(storage.getAgentPanelPosition).mockReturnValue({ x: 100, y: 100 });
    vi.mocked(storage.clampToViewport).mockImplementation((x, y) => ({ x, y }));

    const { result: result1 } = renderHook(() => useAgentPanelPosition('workspace-1'));
    const { result: result2 } = renderHook(() => useAgentPanelPosition('workspace-2'));

    act(() => {
      result1.current.setPosition(100, 100);
    });

    expect(vi.mocked(storage.setAgentPanelPosition)).toHaveBeenCalledWith('workspace-1', 100, 100);

    vi.mocked(storage.setAgentPanelPosition).mockClear();

    act(() => {
      result2.current.setPosition(200, 200);
    });

    expect(vi.mocked(storage.setAgentPanelPosition)).toHaveBeenCalledWith('workspace-2', 200, 200);
  });
});
