"use client";
import * as React from "react";
import type { AgentOption } from "./agent-picker-types";
import {
  agentStorageKey,
  readStoredAgentId,
  writeStoredAgentId,
  resolveInitialAgentId,
  DRAFT_PREFIX,
} from "./agent-context";
import { useSessionSelectionBridge } from "../session/session-bridges";

/**
 * chat-selection-context.tsx — the shared agent selection for one chat surface.
 *
 * The composer's agent chip AND the empty-state gallery both need to reflect
 * and drive the SAME selection, so the selection lives in a provider that wraps
 * the whole shell. The composer reads it through `useComposerSelectionState`,
 * which transparently falls back to a self-contained local store when no
 * provider is present (a bare `<MessageComposer>` in unit tests / other embeds)
 * — so the composer's behaviour is identical whether or not the picker provider
 * wraps it.
 *
 * The provider also owns the one-time initial-selection resolution
 * (`resolveInitialAgentId`) and per-conversation persistence (mirroring
 * `pinned-context.ts`): writes happen in the committing setters, never in a
 * key-scoped effect, so switching conversations can never persist one chat's
 * selection under another chat's key.
 *
 * ADR-041 reduced the selection to the agent alone: the repo / branch /
 * sandbox-environment half of it described a coding turn, and Oxagen no longer
 * runs one. It also removed the selection LOCK. The lock existed because a
 * code turn claimed a durable `StoredCodeBinding` server-side that pinned the
 * conversation's agent + repo + environment for its lifetime; that binding
 * left with the runtime. What remains is a per-TURN parameter — the stream
 * route's `agentId` merges an agent's instructions and MCP servers into THIS
 * turn only (see app/api/v1/chat/stream/route.ts) — so there is nothing for a
 * conversation-scoped lock to protect, and freezing the composer chip would
 * also strand the picker's "default assistant" star, which is a workspace
 * preference rather than conversation state. The v2 session-settings AgentRow
 * still shows an agent lock, but it is derived from server truth
 * (`computeSessionLocks({ hasMessages })`), not from a client-side latch.
 */

/** The atomic selection the picker applies to the composer. */
export interface AgentSelectionApply {
  /** Selected agent public id, or null for the "Default assistant". */
  agentId: string | null;
}

export interface ChatSelectionStore {
  selectedAgentId: string | null;
  /** Set the agent and persist the choice for this conversation. */
  setSelectedAgentId: (id: string | null) => void;
  /** Apply an agent selection (the picker's confirm). */
  applyAgentSelection: (sel: AgentSelectionApply) => void;
}

const ChatSelectionContext = React.createContext<ChatSelectionStore | null>(
  null,
);

/** The shared selection store, or null when no provider wraps the tree. */
export function useChatSelectionContext(): ChatSelectionStore | null {
  return React.useContext(ChatSelectionContext);
}

/**
 * The composer's selection state: the unified session store when the
 * chat_ux_v2 provider wraps the tree (see ../session/session-bridges.tsx),
 * else the shared provider store when one wraps the composer (the chat
 * surface), else a self-contained local store. Always call every hook
 * (rules-of-hooks) and pick the highest-priority store present.
 */
export function useComposerSelectionState(): ChatSelectionStore {
  const sessionBridge = useSessionSelectionBridge();
  const shared = useChatSelectionContext();
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const applyLocal = React.useCallback(
    (sel: AgentSelectionApply) => setAgentId(sel.agentId),
    [],
  );
  const local = React.useMemo<ChatSelectionStore>(
    () => ({
      selectedAgentId: agentId,
      setSelectedAgentId: setAgentId,
      applyAgentSelection: applyLocal,
    }),
    [agentId, applyLocal],
  );
  return sessionBridge ?? shared ?? local;
}

export interface ChatSelectionProviderProps {
  agents: AgentOption[];
  /** URL `?agent=` binding (Ask page session binding); highest priority. */
  boundAgentId: string | null;
  /** The workspace user's default agent preference (agt_… public id). */
  workspaceDefaultAgentId: string | null;
  conversationId: string | null;
  workspaceSlug: string | undefined;
  /** True for a brand-new chat (no conversation yet) — gates the workspace default. */
  isNewConversation: boolean;
  children: React.ReactNode;
}

/**
 * Owns the shared selection for a chat surface: initial resolution, per-turn
 * state, and per-conversation persistence. Wrap the shell so the composer chip
 * and the empty-state gallery share one selection.
 */
export function ChatSelectionProvider({
  boundAgentId,
  workspaceDefaultAgentId,
  conversationId,
  workspaceSlug,
  isNewConversation,
  children,
}: ChatSelectionProviderProps) {
  // SSR-safe initial (no localStorage): the URL binding, else the workspace
  // default for a new chat. The per-conversation persisted choice is layered
  // on after mount by the hydration effect below.
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
    () =>
      resolveInitialAgentId({
        boundAgentId,
        persistedAgentId: null,
        workspaceDefaultAgentId,
        isNewConversation,
      }),
  );

  // Persist in the committing setter (never a key-scoped effect) so switching
  // conversations can't write the previous chat's agent under the new key.
  const commitAgentId = React.useCallback(
    (id: string | null) => {
      setSelectedAgentId(id);
      writeStoredAgentId(agentStorageKey(workspaceSlug, conversationId), id);
    },
    [workspaceSlug, conversationId],
  );

  const applyAgentSelection = React.useCallback(
    (sel: AgentSelectionApply) => commitAgentId(sel.agentId),
    [commitAgentId],
  );

  // Hydrate the per-conversation persisted selection on mount / conversation
  // switch, carrying a draft selection onto the real conversation key the first
  // time a new chat gets an id (draft → conv, never conv → conv).
  const prevKeyRef = React.useRef(
    agentStorageKey(workspaceSlug, conversationId),
  );
  React.useEffect(() => {
    const key = agentStorageKey(workspaceSlug, conversationId);
    const prevKey = prevKeyRef.current;
    prevKeyRef.current = key;

    let persisted = readStoredAgentId(key);
    if (!persisted && prevKey !== key && prevKey.startsWith(DRAFT_PREFIX)) {
      const carried = readStoredAgentId(prevKey);
      if (carried) {
        writeStoredAgentId(key, carried);
        writeStoredAgentId(prevKey, null);
        persisted = carried;
      }
    }

    setSelectedAgentId(
      resolveInitialAgentId({
        boundAgentId,
        persistedAgentId: persisted,
        workspaceDefaultAgentId,
        isNewConversation,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-hydrate only on conversation switch; the rest are stable server props for this mount
  }, [conversationId]);

  const store = React.useMemo<ChatSelectionStore>(
    () => ({
      selectedAgentId,
      setSelectedAgentId: commitAgentId,
      applyAgentSelection,
    }),
    [selectedAgentId, commitAgentId, applyAgentSelection],
  );

  return (
    <ChatSelectionContext.Provider value={store}>
      {children}
    </ChatSelectionContext.Provider>
  );
}
