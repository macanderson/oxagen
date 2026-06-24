'use client';

import { useAgentPanel } from '@/providers/agent-panel-provider';
import { useAgentPanelConfig } from '@/hooks/use-agent-panel-config';
import { AgentPanelLauncher } from './agent-panel-launcher';

/**
 * LowerRightLauncher — renders the agent panel launcher button in the lower-right corner.
 * Only renders when buttonLocation is set to 'lower-right'.
 * Uses the global agent panel state from AgentPanelProvider.
 *
 * @param initialButtonLocation - The initial button location from SSR context
 */
export function LowerRightLauncher({
  initialButtonLocation = 'lower-right',
}: {
  initialButtonLocation?: 'lower-right' | 'topnav' | 'sidebar' | 'command-palette-only';
}) {
  const { isOpen, toggle } = useAgentPanel();
  const { buttonLocation } = useAgentPanelConfig(initialButtonLocation);

  // Only render if buttonLocation is 'lower-right'
  if (buttonLocation !== 'lower-right') {
    return null;
  }

  return (
    <AgentPanelLauncher
      variant="lower-right"
      isOpen={isOpen}
      onClick={toggle}
    />
  );
}
