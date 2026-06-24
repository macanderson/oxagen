'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useParams } from 'next/navigation';
import { AgentPanel } from '@/components/agent/agent-panel';
import { useAgentPanelConfig } from '@/hooks/use-agent-panel-config';

/**
 * Context interface for the Agent Panel state
 */
interface AgentPanelContextValue {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
  open: () => void;
}

/**
 * React Context for Agent Panel state
 * Provides global access to panel open/close state and control methods
 */
const AgentPanelContext = createContext<AgentPanelContextValue | undefined>(undefined);

/**
 * Props for the AgentPanelProvider component
 */
interface AgentPanelProviderProps {
  children: ReactNode;
  workspaceId?: string;
}

/**
 * Provider component for managing Agent Panel state globally.
 * Wraps the application and manages the open/closed state of the floating agent panel.
 * Renders the AgentPanel component internally when open.
 *
 * Automatically derives workspaceSlug from URL params if workspaceId is not provided.
 *
 * @param children - The child components to wrap
 * @param workspaceId - The workspace ID to pass to AgentPanel for position storage (auto-derived from URL if not provided)
 */
export function AgentPanelProvider({ children, workspaceId: propWorkspaceId }: AgentPanelProviderProps) {
  const params = useParams<{ orgSlug?: string; workspaceSlug?: string }>();
  // Use provided workspaceId or derive from URL params
  const workspaceId = propWorkspaceId || params?.workspaceSlug;

  const [isOpen, setIsOpen] = useState(false);
  // Get panel config (for potential future use)
  useAgentPanelConfig('lower-right');

  /**
   * Toggle the panel open/closed state
   */
  const toggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  /**
   * Close the panel
   */
  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  /**
   * Open the panel
   */
  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const value: AgentPanelContextValue = {
    isOpen,
    toggle,
    close,
    open,
  };

  return (
    <AgentPanelContext.Provider value={value}>
      {children}
      {workspaceId && <AgentPanel workspaceId={workspaceId} isOpen={isOpen} onClose={close} />}
    </AgentPanelContext.Provider>
  );
}

/**
 * Hook to access the Agent Panel context.
 * Must be used within an AgentPanelProvider.
 *
 * @returns The Agent Panel context value with state and control methods
 * @throws Error if used outside of AgentPanelProvider
 */
export function useAgentPanel(): AgentPanelContextValue {
  const context = useContext(AgentPanelContext);
  if (context === undefined) {
    throw new Error('useAgentPanel must be used within an AgentPanelProvider');
  }
  return context;
}
