"use client";
/**
 * use-agent-panel-store.tsx — Unified state management for the in-app AI agent panel.
 *
 * Manages:
 *   - Panel visibility: open | collapsed | closed
 *   - Size mode: standard (right 1/3, 80% height) | expanded (right 2/3, 100% height)
 *   - Agent status: idle | active | completed
 *   - Conversation title (persisted across page navigations)
 *
 * State lives in a React context mounted once at the org layout boundary so it
 * persists across all page navigations without losing conversation context.
 */

import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Panel visibility state */
export type PanelVisibility = "open" | "collapsed" | "closed";

/** Panel size mode */
export type PanelSizeMode = "standard" | "expanded";

/** Agent activity status */
export type AgentStatus = "idle" | "active" | "completed";

export interface AgentPanelState {
  /** Whether the panel is open, collapsed to the bottom bar, or fully closed. */
  visibility: PanelVisibility;
  /** Standard = right 1/3 at 80% height; Expanded = right 2/3 at 100% height. */
  sizeMode: PanelSizeMode;
  /** Reflects the current agent turn state for the status indicator. */
  status: AgentStatus;
  /** The current conversation title shown in the header and collapsed bar. */
  conversationTitle: string | null;
  /**
   * Public id of the conversation the panel is currently driving (null before
   * the first message is sent). Used to build the "Open in conversations" link
   * that continues the chat on the full /ask page.
   */
  conversationPublicId: string | null;
  /**
   * Monotonic counter bumped on `startNewChat`. The panel keys its chat shell
   * off this value so starting a new chat remounts the shell into a clean,
   * empty state instead of leaving stale conversation state behind.
   */
  newChatNonce: number;
}

export interface AgentPanelActions {
  /** Open the panel (from closed or collapsed). */
  open: () => void;
  /** Close the panel entirely (no bottom bar indicator for this conversation). */
  close: () => void;
  /** Collapse the panel — shows the bottom bar with conversation title + status. */
  collapse: () => void;
  /** Toggle between standard and expanded size modes. */
  toggleSize: () => void;
  /** Set the size mode explicitly. */
  setSizeMode: (mode: PanelSizeMode) => void;
  /** Update the agent status indicator. */
  setStatus: (status: AgentStatus) => void;
  /** Update the conversation title (shown in header + collapsed bar). */
  setConversationTitle: (title: string | null) => void;
  /** Record the public id of the conversation the panel is now driving. */
  setConversationPublicId: (publicId: string | null) => void;
  /** Start a new chat — resets conversation title, public id, and messages. */
  startNewChat: () => void;
}

export type AgentPanelStore = AgentPanelState & AgentPanelActions;

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const AgentPanelContext = React.createContext<AgentPanelStore | null>(null);
AgentPanelContext.displayName = "AgentPanelContext";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function AgentPanelStoreProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [visibility, setVisibility] = React.useState<PanelVisibility>("closed");
  const [sizeMode, setSizeModeState] =
    React.useState<PanelSizeMode>("standard");
  const [status, setStatusState] = React.useState<AgentStatus>("idle");
  const [conversationTitle, setConversationTitleState] = React.useState<
    string | null
  >(null);
  const [conversationPublicId, setConversationPublicIdState] = React.useState<
    string | null
  >(null);
  const [newChatNonce, setNewChatNonce] = React.useState(0);

  const open = React.useCallback(() => setVisibility("open"), []);
  const close = React.useCallback(() => {
    setVisibility("closed");
    setStatusState("idle");
  }, []);
  const collapse = React.useCallback(() => setVisibility("collapsed"), []);

  const toggleSize = React.useCallback(() => {
    setSizeModeState((prev) => (prev === "standard" ? "expanded" : "standard"));
  }, []);

  const setSizeMode = React.useCallback((mode: PanelSizeMode) => {
    setSizeModeState(mode);
  }, []);

  const setStatus = React.useCallback((s: AgentStatus) => {
    setStatusState(s);
  }, []);

  const setConversationTitle = React.useCallback((title: string | null) => {
    setConversationTitleState(title);
  }, []);

  const setConversationPublicId = React.useCallback(
    (publicId: string | null) => {
      setConversationPublicIdState(publicId);
    },
    [],
  );

  const startNewChat = React.useCallback(() => {
    setConversationTitleState(null);
    setConversationPublicIdState(null);
    setStatusState("idle");
    // Bump the nonce so the panel remounts its chat shell into a clean state.
    setNewChatNonce((n) => n + 1);
    // Visibility stays open — user sees the empty new-chat state.
  }, []);

  const value = React.useMemo<AgentPanelStore>(
    () => ({
      visibility,
      sizeMode,
      status,
      conversationTitle,
      conversationPublicId,
      newChatNonce,
      open,
      close,
      collapse,
      toggleSize,
      setSizeMode,
      setStatus,
      setConversationTitle,
      setConversationPublicId,
      startNewChat,
    }),
    [
      visibility,
      sizeMode,
      status,
      conversationTitle,
      conversationPublicId,
      newChatNonce,
      open,
      close,
      collapse,
      toggleSize,
      setSizeMode,
      setStatus,
      setConversationTitle,
      setConversationPublicId,
      startNewChat,
    ],
  );

  return (
    <AgentPanelContext.Provider value={value}>
      {children}
    </AgentPanelContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Access the unified agent panel state and actions.
 * Must be used within AgentPanelStoreProvider.
 */
export function useAgentPanelStore(): AgentPanelStore {
  const ctx = React.useContext(AgentPanelContext);
  if (!ctx) {
    throw new Error(
      "useAgentPanelStore must be used inside AgentPanelStoreProvider",
    );
  }
  return ctx;
}
