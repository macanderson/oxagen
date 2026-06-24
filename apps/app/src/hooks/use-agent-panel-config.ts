'use client';

import { useCallback, useState } from 'react';

/**
 * Type for agent panel button location setting.
 * Options: 'lower-right', 'topnav', 'sidebar', 'command-palette-only'
 */
export type AgentPanelButtonLocation = 'lower-right' | 'topnav' | 'sidebar' | 'command-palette-only';

/**
 * Hook to manage agent panel button location configuration.
 * Reads the current setting from workspace context (passed as prop via SSR)
 * and provides a setter to update it via server action.
 *
 * @param initialButtonLocation - The initial button location from SSR context (default: 'lower-right')
 * @returns Object containing current buttonLocation and setter function
 */
export function useAgentPanelConfig(
  initialButtonLocation: AgentPanelButtonLocation = 'lower-right',
) {
  const [buttonLocation, setButtonLocationState] = useState<AgentPanelButtonLocation>(
    initialButtonLocation,
  );

  /**
   * Update button location.
   * In the future, this will call a server action to persist to the database.
   * For now, updates the local state.
   */
  const setButtonLocation = useCallback(
    (location: AgentPanelButtonLocation) => {
      setButtonLocationState(location);
      // TODO: Call server action to persist the preference:
      // await updateAgentPanelConfigAction({ buttonLocation: location });
    },
    [],
  );

  return {
    buttonLocation,
    setButtonLocation,
  };
}
