'use client';

import { useAgentPanel } from '@/providers/agent-panel-provider';
import { useAgentPanelConfig } from '@/hooks/use-agent-panel-config';
import { AgentPanelLauncher } from './agent-panel-launcher';

/**
 * TopnavLauncher — renders the agent panel launcher button in the top navigation area.
 * Only renders when buttonLocation is set to 'topnav'.
 * Uses the global agent panel state from AgentPanelProvider.
 *
 * @param initialButtonLocation - The initial button location from SSR context
 */
export function TopnavLauncher({
  initialButtonLocation = 'topnav',
}: {
  initialButtonLocation?: 'topnav' | 'lower-right' | 'sidebar' | 'command-palette-only';
}) {
  const { isOpen, toggle } = useAgentPanel();
  const { buttonLocation } = useAgentPanelConfig(initialButtonLocation);

  // Only render if buttonLocation is 'topnav'
  if (buttonLocation !== 'topnav') {
    return null;
  }

  return (
    <AgentPanelLauncher
      variant="topnav"
      isOpen={isOpen}
      onClick={toggle}
    />
  );
}
