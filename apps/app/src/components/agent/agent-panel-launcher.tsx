'use client';

import { Wand2 } from 'lucide-react';
import type { AgentPanelButtonLocation } from '@/hooks/use-agent-panel-config';
import './agent-panel-launcher.css';

/**
 * Props for the AgentPanelLauncher component
 */
interface AgentPanelLauncherProps {
  /** The button location variant */
  variant: AgentPanelButtonLocation;
  /** Whether the agent panel is currently open */
  isOpen: boolean;
  /** Callback when the launcher button is clicked */
  onClick: () => void;
  /** Optional label text (used for sidebar variant) */
  label?: string;
}

/**
 * Launcher button component with multi-variant support.
 * Renders different button styles based on the variant prop:
 * - 'lower-right': Fixed floating button with gradient background
 * - 'sidebar': Button with label, appears in sidebar context
 * - 'topnav': Minimal icon-only button for top navigation
 * - 'command-palette-only': Hidden (triggered only via command palette)
 *
 * @param variant - The button location variant
 * @param isOpen - Whether the agent panel is currently open
 * @param onClick - Callback when the button is clicked
 * @param label - Optional label text for sidebar variant
 */
export function AgentPanelLauncher({
  variant,
  isOpen,
  onClick,
  label = 'Agent',
}: AgentPanelLauncherProps) {
  // Command-palette-only variant should not render in the UI
  if (variant === 'command-palette-only') {
    return null;
  }

  // Render based on variant
  switch (variant) {
    case 'lower-right':
      return (
        <button
          className="agent-panel-launcher agent-panel-launcher--lower-right"
          onClick={onClick}
          aria-label="Open agent panel"
          aria-pressed={isOpen}
          title="Open agent panel (Cmd+Shift+A)"
          type="button"
        >
          <Wand2 size={24} />
        </button>
      );

    case 'sidebar':
      return (
        <button
          className={`agent-panel-launcher agent-panel-launcher--sidebar ${isOpen ? 'is-open' : ''}`}
          onClick={onClick}
          aria-label={`Toggle agent panel${isOpen ? ' (open)' : ''}`}
          aria-pressed={isOpen}
          type="button"
        >
          <Wand2 size={18} />
          <span>{label}</span>
        </button>
      );

    case 'topnav':
      return (
        <button
          className="agent-panel-launcher agent-panel-launcher--topnav"
          onClick={onClick}
          aria-label="Open agent panel"
          aria-pressed={isOpen}
          title="Open agent panel (Cmd+Shift+A)"
          type="button"
        >
          <Wand2 size={18} />
        </button>
      );

    default:
      // Fallback to lower-right for unknown variants
      return (
        <button
          className="agent-panel-launcher agent-panel-launcher--lower-right"
          onClick={onClick}
          aria-label="Open agent panel"
          aria-pressed={isOpen}
          title="Open agent panel (Cmd+Shift+A)"
          type="button"
        >
          <Wand2 size={24} />
        </button>
      );
  }
}
