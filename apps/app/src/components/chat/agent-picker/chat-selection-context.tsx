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

/**
 * chat-selection-context.tsx — the shared agent/repo/environment selection for
 * one chat surface.
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
 */

/** The atomic selection the picker applies to the composer. */
export interface AgentSelectionApply {
  /** Selected agent public id, or null for the "Default assistant". */
  agentId: string | null;
  /** Repo key for a code agent's session (undefined = leave unchanged). */
  repoKey?: string | null;
  /** Environment id for a code agent's session (undefined = leave unchanged). */
  envId?: string | null;
}

export interface ChatSelectionStore {
  selectedAgentId: string | null;
  selectedRepoKey: string | null;
  selectedEnvId: string | null;
  /** Set the agent and persist the choice for this conversation. */
  setSelectedAgentId: (id: string | null) => void;
  setSelectedRepoKey: (key: string | null) => void;
  setSelectedEnvId: (id: string | null) => void;
  /** Apply an agent + optional repo/env atomically (the picker's confirm). */
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
 * The composer's selection state: the shared provider store when one wraps the
 * composer (the chat surface), else a self-contained local store. Always call
 * both hooks (rules-of-hooks) and pick the shared store when present.
 */
export function useComposerSelectionState(): ChatSelectionStore {
  const shared = useChatSelectionContext();
  const [agentId, setAgentId] = React.useState<string | null>(null);
  const [repoKey, setRepoKey] = React.useState<string | null>(null);
  const [envId, setEnvId] = React.useState<string | null>(null);
  const applyLocal = React.useCallback((sel: AgentSelectionApply) => {
    setAgentId(sel.agentId);
    if (sel.repoKey !== undefined) setRepoKey(sel.repoKey);
    if (sel.envId !== undefined) setEnvId(sel.envId);
  }, []);
  const local = React.useMemo<ChatSelectionStore>(
    () => ({
      selectedAgentId: agentId,
      selectedRepoKey: repoKey,
      selectedEnvId: envId,
      setSelectedAgentId: setAgentId,
      setSelectedRepoKey: setRepoKey,
      setSelectedEnvId: setEnvId,
      applyAgentSelection: applyLocal,
    }),
    [agentId, repoKey, envId, applyLocal],
  );
  return shared ?? local;
}

export interface ChatSelectionProviderProps {
  agents: AgentOption[];
  /** URL `?agent=` binding (Ask page session binding); highest priority. */
  boundAgentId: string | null;
  /** The workspace user's default agent preference (agt_… public id). */
  workspaceDefaultAgentId: string | null;
  /** Precomputed default repo key for a code agent's session prefill. */
  defaultRepoKey: string | null;
  /** Precomputed default environment id for a code agent's session prefill. */
  defaultEnvId: string | null;
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
  agents,
  boundAgentId,
  workspaceDefaultAgentId,
  defaultRepoKey,
  defaultEnvId,
  conversationId,
  workspaceSlug,
  isNewConversation,
  children,
}: ChatSelectionProviderProps) {
  // SSR-safe initial (no localStorage): URL binding, else the workspace default
  // for a new chat. The per-conversation persisted choice is layered on after
  // mount by the hydration effect below.
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
    () =>
      resolveInitialAgentId({
        boundAgentId,
        persistedAgentId: null,
        workspaceDefaultAgentId,
        isNewConversation,
      }),
  );
  const [selectedRepoKey, setSelectedRepoKey] = React.useState<string | null>(
    null,
  );
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(null);

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
    (sel: AgentSelectionApply) => {
      commitAgentId(sel.agentId);
      if (sel.repoKey !== undefined) setSelectedRepoKey(sel.repoKey);
      if (sel.envId !== undefined) setSelectedEnvId(sel.envId);
    },
    [commitAgentId],
  );

  // Hydrate the per-conversation persisted selection on mount / conversation
  // switch, carrying a draft selection onto the real conversation key the first
  // time a new chat gets an id (draft → conv, never conv → conv). Prefills the
  // repo/env session for a code agent from the workspace defaults.
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

    const resolved = resolveInitialAgentId({
      boundAgentId,
      persistedAgentId: persisted,
      workspaceDefaultAgentId,
      isNewConversation,
    });
    setSelectedAgentId(resolved);

    const agent = resolved
      ? (agents.find((a) => a.agentId === resolved) ?? null)
      : null;
    if (agent?.isCode) {
      setSelectedRepoKey((prev) => prev ?? defaultRepoKey);
      setSelectedEnvId((prev) => prev ?? defaultEnvId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-hydrate only on conversation switch; the rest are stable server props for this mount
  }, [conversationId]);

  const store = React.useMemo<ChatSelectionStore>(
    () => ({
      selectedAgentId,
      selectedRepoKey,
      selectedEnvId,
      setSelectedAgentId: commitAgentId,
      setSelectedRepoKey,
      setSelectedEnvId,
      applyAgentSelection,
    }),
    [
      selectedAgentId,
      selectedRepoKey,
      selectedEnvId,
      commitAgentId,
      applyAgentSelection,
    ],
  );

  return (
    <ChatSelectionContext.Provider value={store}>
      {children}
    </ChatSelectionContext.Provider>
  );
}
