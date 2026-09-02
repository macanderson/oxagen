"use client";
/**
 * session-store.tsx — the React face of the unified chat session (chat_ux_v2).
 *
 * ONE provider owns the whole run context; `updateSession` is the ONLY write
 * path (it funnels through `applySessionPatch`, so the org→repo→branch
 * cascades can never be skipped). Everything on screen — header subtitle,
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
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import {
  applyCodeBinding,
  applyCodeMemory,
  applySessionPatch,
  agentMemoryKey,
  codeMemoryOf,
  computeSessionLocks,
  decodeCodeMemory,
  decodeSessionState,
  encodeCodeMemory,
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
  /**
   * Mark that a message was sent in this view: locks the agent, persists the
   * agent's code-context memory, and (for a new chat) migrates the draft
   * session onto the real conversation key.
   */
  noteMessageSent: (conversationId: string | null) => void;
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
  /** The conversation's durable code binding — authoritative when present. */
  codeBinding?: StoredCodeBinding | null;
  children: React.ReactNode;
}

export function ChatSessionProvider({
  workspaceSlug,
  conversationId,
  boundAgentId,
  isNewConversation,
  hasMessages,
  seed,
  codeBinding = null,
  children,
}: ChatSessionProviderProps) {
  // The defaults snapshot is fixed for the mount — it is both the reset
  // target and the dirty-dot baseline. Seed props are server-resolved and
  // stable for the page render.
  const defaults = React.useMemo(
    () => seedSessionState(seed),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed is a fresh object each RSC render; its fields are stable for the mount
    [
      seed.defaultAgentId,
      seed.defaultRepoKey,
      seed.defaultEnvId,
      seed.textModel,
      seed.textTier,
      seed.budgetUsd,
    ],
  );

  // SSR-safe initial state (no localStorage on the server): defaults, then
  // the URL agent binding, then the binding force. The persisted session is
  // layered on after mount by the hydration effect below.
  const [state, setState] = React.useState<ChatSessionState>(() => {
    let initial = defaults;
    if (boundAgentId && isNewConversation) {
      initial = applySessionPatch(initial, { agentId: boundAgentId });
    }
    return applyCodeBinding(initial, codeBinding);
  });

  const [clientLocked, setClientLocked] = React.useState(false);
  const isBound = codeBinding !== null;
  const locks = React.useMemo(
    () =>
      computeSessionLocks({
        hasMessages,
        codeBinding: isBound ? codeBinding : null,
        clientLocked,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on isBound: the binding object's identity churns each RSC render, its presence doesn't
    [hasMessages, isBound, clientLocked],
  );
  const locksRef = React.useRef(locks);
  React.useEffect(() => {
    locksRef.current = locks;
  }, [locks]);

  const storageKey = sessionStorageKey(workspaceSlug, conversationId);
  const storageKeyRef = React.useRef(storageKey);

  // ── The single write path ────────────────────────────────────────────────
  const updateSession = React.useCallback(
    (patch: ChatSessionPatch) => {
      setState((prev) => {
        const l = locksRef.current;
        const rejected: ChatSessionPatch = { ...patch };
        if (l.agent) delete rejected.agentId;
        if (l.code) {
          delete rejected.org;
          delete rejected.repoKey;
          delete rejected.envId;
          // Branch stays editable — the binding pins repo+env, not branch.
        }
        const next = applySessionPatch(prev, rejected);
        writeStorage(storageKeyRef.current, encodeSessionState(next));
        // Agent switch before the first message: overlay that agent's
        // remembered code context (last org/repo/branch/env in this
        // workspace) so the Code section opens where the user left it.
        if (
          rejected.agentId !== undefined &&
          rejected.agentId !== prev.agentId &&
          rejected.agentId !== null
        ) {
          const memory = decodeCodeMemory(
            readStorage(agentMemoryKey(workspaceSlug, rejected.agentId)),
          );
          if (memory) {
            const withMemory = applyCodeMemory(next, memory);
            writeStorage(storageKeyRef.current, encodeSessionState(withMemory));
            return withMemory;
          }
        }
        return next;
      });
    },
    [workspaceSlug],
  );

  const resetToDefaults = React.useCallback(() => {
    setState(() => {
      const next = applyCodeBinding(defaults, codeBinding);
      writeStorage(storageKeyRef.current, encodeSessionState(next));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- codeBinding identity churns each render; reset reads the latest via closure per call
  }, [defaults, codeBinding?.agentId, codeBinding?.environmentId]);

  const noteMessageSent = React.useCallback(
    (newConversationId: string | null) => {
      setClientLocked(true);
      setState((prev) => {
        // Persist this agent's code context for next time.
        if (prev.agentId) {
          writeStorage(
            agentMemoryKey(workspaceSlug, prev.agentId),
            encodeCodeMemory(codeMemoryOf(prev)),
          );
        }
        // Draft → conversation key migration on first send.
        const prevKey = storageKeyRef.current;
        if (newConversationId && prevKey.startsWith(SESSION_DRAFT_PREFIX)) {
          const newKey = sessionStorageKey(workspaceSlug, newConversationId);
          writeStorage(newKey, encodeSessionState(prev));
          writeStorage(prevKey, null);
          storageKeyRef.current = newKey;
        }
        return prev;
      });
    },
    [workspaceSlug],
  );

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
      // The durable binding always wins last.
      return applyCodeBinding(next, codeBinding);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-hydrate only on conversation switch; the rest are stable server props for this mount
  }, [conversationId]);

  // Keep the state pinned to the binding if it appears mid-session (first
  // code turn claims it server-side and the page revalidates).
  React.useEffect(() => {
    if (!codeBinding) return;
    setState((prev) => applyCodeBinding(prev, codeBinding));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- force to primitive binding values; the object identity churns each render
  }, [
    codeBinding?.agentId,
    codeBinding?.connectionId,
    codeBinding?.owner,
    codeBinding?.name,
    codeBinding?.environmentId,
  ]);

  const isDirty = sessionDiffersFromDefaults(state, defaults);

  const store = React.useMemo<ChatSessionStore>(
    () => ({
      state,
      defaults,
      locks,
      isDirty,
      updateSession,
      resetToDefaults,
      noteMessageSent,
    }),
    [
      state,
      defaults,
      locks,
      isDirty,
      updateSession,
      resetToDefaults,
      noteMessageSent,
    ],
  );

  return (
    <ChatSessionContext.Provider value={store}>
      {children}
    </ChatSessionContext.Provider>
  );
}
