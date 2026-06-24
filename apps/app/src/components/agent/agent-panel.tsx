'use client';

import { useAgentPanelConfig } from '@/hooks/use-agent-panel-config';
import { useAgentPanelPosition } from '@/hooks/use-agent-panel-position';
import { X } from 'lucide-react';
import './agent-panel.css';

/**
 * Props for the AgentPanel component
 */
interface AgentPanelProps {
  /** The workspace ID to scope position storage */
  workspaceId: string;
  /** Whether the panel is open */
  isOpen: boolean;
  /** Callback when the panel close button is clicked */
  onClose: () => void;
}

/**
 * Floating glassmorphic agent panel component with drag support.
 * Renders as a fixed position panel with drag-to-move functionality.
 * Position is persisted to localStorage and clamped to viewport bounds.
 *
 * @param workspaceId - The workspace ID to scope position storage
 * @param isOpen - Whether the panel is visible
 * @param onClose - Callback when the close button is clicked
 */
export function AgentPanel({ workspaceId, isOpen, onClose }: AgentPanelProps) {
  // Get position state and drag handlers from the position hook
  const { x, y, onPointerDown, isInitialized } = useAgentPanelPosition(workspaceId);

  // Get configuration (for future use, currently tracks button location)
  const { buttonLocation } = useAgentPanelConfig('lower-right');

  // Don't render if closed or not initialized yet
  if (!isOpen || !isInitialized) {
    return null;
  }

  return (
    <div
      className="agent-panel"
      style={{
        left: `${x}px`,
        top: `${y}px`,
      }}
      onPointerDown={onPointerDown}
    >
      <header className="agent-panel-header" data-agent-panel-header>
        <h2 className="agent-panel-title">Agent</h2>
        <button
          className="agent-panel-close"
          onClick={onClose}
          aria-label="Close agent panel"
          type="button"
        >
          <X size={16} />
        </button>
      </header>
      <div className="agent-panel-content">
        {/* Content will be populated with chat messages and input */}
        <p style={{ fontSize: '12px', color: '#888' }}>Agent panel initialized</p>
      </div>
    </div>
  );
}
