"use client";
/**
 * session-store.tsx — the React face of the unified chat session (chat_ux_v2).
 *
 * ONE provider owns the whole run context; `updateSession` is the ONLY write
 * path (it funnels through `applySessionPatch`). Everything on screen — header
 * subtitle,
 * SessionSettings drawer/slide-over/rail, the composer's submit payload — is a
 * projection of `state`, which is what makes a header-vs-panel mismatch
 * structurally impossible.
 *
 * Persistence follows the committing-setter convention established by
 * `pinned-context.ts` / `chat-selection-context.tsx`: writes happen inside the
 * setters (never a key-scoped effect), so switching conversations can never
 * persist one chat's session under another chat's key. A brand-new chat
 * persists under a workspace draft key, migrated to the conversation key on
 * first send.
 */
import * as React from "react";
import {
  applySessionPatch,
  computeSessionLocks,
  decodeSessionState,
  encodeSessionState,
  seedSessionState,
  sessionDiffersFromDefaults,
  sessionStorageKey,
  SESSION_DRAFT_PREFIX,
  type ChatSessionPatch,
  type ChatSessionState,
  type SessionLocks,
  type SessionSeed,
} from "./session-state";

// ---------------------------------------------------------------------------
// Storage IO (never throws — private mode degrades to in-memory only)
// ---------------------------------------------------------------------------

function readStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the session just doesn't survive a reload.
  }
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface ChatSessionStore {
  state: ChatSessionState;
  /** The workspace-default snapshot — "Reset to defaults" target. */
  defaults: ChatSessionState;
  locks: SessionLocks;
  /** True when any setting differs from the defaults (cog accent dot). */
  isDirty: boolean;
  /** The ONE write path. Locked fields are rejected, not silently dropped. */
  updateSession: (patch: ChatSessionPatch) => void;
  resetToDefaults: () => void;
}

const ChatSessionContext = React.createContext<ChatSessionStore | null>(null);

/** The unified session store, or null when the provider isn't mounted
 * (flag off / legacy surface). */
export function useChatSessionContext(): ChatSessionStore | null {
  return React.useContext(ChatSessionContext);
}

/** The unified session store; throws when used outside the provider. */
export function useChatSession(): ChatSessionStore {
  const store = React.useContext(ChatSessionContext);
  if (!store) {
    throw new Error("useChatSession must be used within ChatSessionProvider");
  }
  return store;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ChatSessionProviderProps {
  workspaceSlug: string | undefined;
  conversationId: string | null;
  /** URL `?agent=` binding — wins over everything for a new chat. */
  boundAgentId: string | null;
  /** True for a brand-new chat (no messages / no id yet). */
  isNewConversation: boolean;
  /** True when the conversation already has messages (locks the agent). */
  hasMessages: boolean;
  /** Workspace defaults resolved server-side. */
  seed: SessionSeed;
  children: React.ReactNode;
}

export function ChatSessionProvider({
  workspaceSlug,
  conversationId,
  boundAgentId,
  isNewConversation,
  hasMessages,
  seed,
  children,
}: ChatSessionProviderProps) {
  // The defaults snapshot is fixed for the mount — it is both the reset
  // target and the dirty-dot baseline. Seed props are server-resolved and
  // stable for the page render.
  const defaults = React.useMemo(
    () => seedSessionState(seed),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed is a fresh object each RSC render; its fields are stable for the mount
    [seed.defaultAgentId, seed.textModel, seed.textTier, seed.budgetUsd],
  );

  // SSR-safe initial state (no localStorage on the server): defaults, then
  // the URL agent binding. The persisted session is layered on after mount by
  // the hydration effect below.
  const [state, setState] = React.useState<ChatSessionState>(() =>
    boundAgentId && isNewConversation
      ? applySessionPatch(defaults, { agentId: boundAgentId })
      : defaults,
  );

  // `hasMessages` is the shell's `messages.length > 0 || isStreaming`, and
  // isStreaming flips true synchronously at submit — so the agent lock lands on
  // the same commit as the send, with no client-side latch to keep in sync (and
  // it correctly releases again if the send fails before a message exists).
  const locks = React.useMemo(
    () => computeSessionLocks({ hasMessages }),
    [hasMessages],
  );
  const locksRef = React.useRef(locks);
  React.useEffect(() => {
    locksRef.current = locks;
  }, [locks]);

  const storageKey = sessionStorageKey(workspaceSlug, conversationId);
  const storageKeyRef = React.useRef(storageKey);

  // ── The single write path ────────────────────────────────────────────────
  const updateSession = React.useCallback((patch: ChatSessionPatch) => {
    setState((prev) => {
      const accepted: ChatSessionPatch = { ...patch };
      if (locksRef.current.agent) delete accepted.agentId;
      const next = applySessionPatch(prev, accepted);
      writeStorage(storageKeyRef.current, encodeSessionState(next));
      return next;
    });
  }, []);

  const resetToDefaults = React.useCallback(() => {
    setState(() => {
      writeStorage(storageKeyRef.current, encodeSessionState(defaults));
      return defaults;
    });
  }, [defaults]);

  // ── Hydration on mount / conversation switch ─────────────────────────────
  React.useEffect(() => {
    const prevKey = storageKeyRef.current;
    const key = sessionStorageKey(workspaceSlug, conversationId);
    storageKeyRef.current = key;

    let persisted = decodeSessionState(readStorage(key), defaults);
    // Carry a draft session onto the real conversation key the first time a
    // new chat gets an id (draft → conv, never conv → conv).
    if (
      !persisted &&
      prevKey !== key &&
      prevKey.startsWith(SESSION_DRAFT_PREFIX)
    ) {
      const carried = decodeSessionState(readStorage(prevKey), defaults);
      if (carried) {
        writeStorage(key, encodeSessionState(carried));
        writeStorage(prevKey, null);
        persisted = carried;
      }
    }

    setState(() => {
      let next = persisted ?? defaults;
      if (!persisted && boundAgentId && isNewConversation) {
        next = applySessionPatch(next, { agentId: boundAgentId });
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-hydrate only on conversation switch; the rest are stable server props for this mount
  }, [conversationId]);

  const isDirty = sessionDiffersFromDefaults(state, defaults);

  const store = React.useMemo<ChatSessionStore>(
    () => ({
      state,
      defaults,
      locks,
      isDirty,
      updateSession,
      resetToDefaults,
    }),
    [state, defaults, locks, isDirty, updateSession, resetToDefaults],
  );

  return (
    <ChatSessionContext.Provider value={store}>
      {children}
    </ChatSessionContext.Provider>
  );
}
