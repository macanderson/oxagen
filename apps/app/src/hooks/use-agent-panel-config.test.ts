// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentPanelConfig, type AgentPanelButtonLocation } from './use-agent-panel-config';

describe('useAgentPanelConfig', () => {
  it('returns default button location when no initial value is provided', () => {
    const { result } = renderHook(() => useAgentPanelConfig());
    expect(result.current.buttonLocation).toBe('lower-right');
  });

  it('returns the initial button location when provided', () => {
    const { result } = renderHook(() => useAgentPanelConfig('sidebar'));
    expect(result.current.buttonLocation).toBe('sidebar');
  });

  it('updates the button location when setButtonLocation is called', () => {
    const { result } = renderHook(() => useAgentPanelConfig());
    expect(result.current.buttonLocation).toBe('lower-right');

    act(() => {
      result.current.setButtonLocation('topnav');
    });

    expect(result.current.buttonLocation).toBe('topnav');
  });

  it('accepts all valid button location values', () => {
    const locations: AgentPanelButtonLocation[] = [
      'lower-right',
      'topnav',
      'sidebar',
      'command-palette-only',
    ];

    locations.forEach((location) => {
      const { result } = renderHook(() => useAgentPanelConfig());

      act(() => {
        result.current.setButtonLocation(location);
      });

      expect(result.current.buttonLocation).toBe(location);
    });
  });

  it('setButtonLocation is memoized and stable across renders', () => {
    const { result, rerender } = renderHook(() => useAgentPanelConfig());
    const firstSetButtonLocation = result.current.setButtonLocation;

    rerender();

    const secondSetButtonLocation = result.current.setButtonLocation;
    expect(firstSetButtonLocation).toBe(secondSetButtonLocation);
  });
});
