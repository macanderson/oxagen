"use client";
import * as React from "react";
import type { AgentOption } from "./agent-picker-types";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import {
  agentStorageKey,
  readStoredAgentId,
  writeStoredAgentId,
  resolveInitialAgentId,
  DRAFT_PREFIX,
} from "./agent-context";
import { useSessionSelectionBridge } from "../session/session-bridges";

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
  /**
   * Branch for a code agent's session (undefined = leave unchanged; null = the
   * repository's default branch, the convention everywhere — see
   * `session-state.ts`'s `branch: string | null`).
   */
  branch?: string | null;
  /** Environment id for a code agent's session (undefined = leave unchanged). */
  envId?: string | null;
}

export interface ChatSelectionStore {
  selectedAgentId: string | null;
  selectedRepoKey: string | null;
  /** Explicit branch for a code agent's session; null = the repo's default. */
  selectedBranch: string | null;
  selectedEnvId: string | null;
  /**
   * True once the conversation's coding target is LOCKED — either a server
   * binding is present (claimed on the conversation's first code turn) or a code
   * turn has already been sent in this view. While locked the agent/repo/env
   * selection cannot change: the pickers render read-only and the committing
   * setters below reject mutations. Mirrors the server, which resolves every
   * later turn from the stored binding.
   */
  selectionLocked: boolean;
  /** Set the agent and persist the choice for this conversation. */
  setSelectedAgentId: (id: string | null) => void;
  setSelectedRepoKey: (key: string | null) => void;
  setSelectedEnvId: (id: string | null) => void;
  /** Apply an agent + optional repo/env atomically (the picker's confirm). */
  applyAgentSelection: (sel: AgentSelectionApply) => void;
  /**
   * Lock the current selection client-side. Called the instant a code turn is
   * sent so the pickers lock immediately, without waiting for the server to
   * claim the durable binding and the page to reload. Idempotent.
   */
  lockSelection: () => void;
}

/**
 * The repo key a stored binding maps to — built the SAME way the option loader
 * builds it (`${connectionId}::${owner}/${name}`, see
 * `_shared/code-mode-data.ts`) so it matches an `availableRepos` entry and the
 * repo selector shows the owner/name label rather than a bare key.
 */
export function repoKeyForBinding(binding: StoredCodeBinding): string {
  return `${binding.connectionId}::${binding.owner}/${binding.name}`;
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
  const [repoKey, setRepoKey] = React.useState<string | null>(null);
  const [branch, setBranch] = React.useState<string | null>(null);
  const [envId, setEnvId] = React.useState<string | null>(null);
  const [locked, setLocked] = React.useState(false);
  // Latest-lock ref so the guarded setters see the current lock state without
  // stale closures (same pattern as the provider store below).
  const lockedRef = React.useRef(locked);
  React.useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);
  const setAgentGuarded = React.useCallback((id: string | null) => {
    if (lockedRef.current) return;
    setAgentId(id);
  }, []);
  // Latest-repo ref so the cascade below can compare against the current repo
  // without a setState updater (an updater must stay pure — React may invoke it
  // twice — so the branch reset can't live inside one).
  const repoKeyRef = React.useRef(repoKey);
  React.useEffect(() => {
    repoKeyRef.current = repoKey;
  }, [repoKey]);
  const setRepoGuarded = React.useCallback((key: string | null) => {
    if (lockedRef.current) return;
    // Cascade (mirrors `applySessionPatch`): a new repo invalidates the branch
    // — it belongs to the repo you just left.
    if (key !== repoKeyRef.current) setBranch(null);
    repoKeyRef.current = key;
    setRepoKey(key);
  }, []);
  const setEnvGuarded = React.useCallback((id: string | null) => {
    if (lockedRef.current) return;
    setEnvId(id);
  }, []);
  const applyLocal = React.useCallback((sel: AgentSelectionApply) => {
    if (lockedRef.current) return;
    setAgentId(sel.agentId);
    if (sel.repoKey !== undefined) {
      // Same cascade as the setter — but the apply is atomic, so an explicit
      // branch in the SAME apply is the user's choice for the new repo and
      // wins over the reset.
      if (sel.repoKey !== repoKeyRef.current && sel.branch === undefined) {
        setBranch(null);
      }
      repoKeyRef.current = sel.repoKey;
      setRepoKey(sel.repoKey);
    }
    if (sel.branch !== undefined) setBranch(sel.branch);
    if (sel.envId !== undefined) setEnvId(sel.envId);
  }, []);
  const lockLocal = React.useCallback(() => setLocked(true), []);
  const local = React.useMemo<ChatSelectionStore>(
    () => ({
      selectedAgentId: agentId,
      selectedRepoKey: repoKey,
      selectedBranch: branch,
      selectedEnvId: envId,
      selectionLocked: locked,
      setSelectedAgentId: setAgentGuarded,
      setSelectedRepoKey: setRepoGuarded,
      setSelectedEnvId: setEnvGuarded,
      applyAgentSelection: applyLocal,
      lockSelection: lockLocal,
    }),
    [
      agentId,
      repoKey,
      branch,
      envId,
      locked,
      setAgentGuarded,
      setRepoGuarded,
      setEnvGuarded,
      applyLocal,
      lockLocal,
    ],
  );
  return sessionBridge ?? shared ?? local;
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
  /**
   * The conversation's stored code binding, claimed on its first code turn (see
   * `code-binding.ts`). When present, the selection is FORCED to the binding
   * (agent + repo + environment) and locked — the pickers render read-only.
   * Null for an unbound conversation.
   */
  codeBinding?: StoredCodeBinding | null;
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
  codeBinding = null,
  children,
}: ChatSelectionProviderProps) {
  // A server binding locks the conversation's coding target — seed the initial
  // selection straight from it (SSR-safe, no localStorage) so a bound
  // conversation renders locked on the very first paint.
  const boundRepoKey = codeBinding ? repoKeyForBinding(codeBinding) : null;

  // SSR-safe initial (no localStorage): the binding when present, else the URL
  // binding, else the workspace default for a new chat. The per-conversation
  // persisted choice is layered on after mount by the hydration effect below.
  const [selectedAgentId, setSelectedAgentId] = React.useState<string | null>(
    () =>
      codeBinding?.agentId ??
      resolveInitialAgentId({
        boundAgentId,
        persistedAgentId: null,
        workspaceDefaultAgentId,
        isNewConversation,
      }),
  );
  const [selectedRepoKey, setSelectedRepoKey] = React.useState<string | null>(
    () => boundRepoKey,
  );
  // null = the repository's default branch (the convention everywhere). A
  // binding pins the repo, not a feature branch, so it seeds no branch.
  const [selectedBranch, setSelectedBranch] = React.useState<string | null>(
    null,
  );
  const [selectedEnvId, setSelectedEnvId] = React.useState<string | null>(
    () => codeBinding?.environmentId ?? null,
  );

  // Client-side lock: flipped the instant a code turn is sent in this view, so
  // the pickers lock immediately rather than waiting for the server to claim the
  // durable binding and the page to reload. A server binding also locks.
  const [clientLocked, setClientLocked] = React.useState(false);
  const selectionLocked = codeBinding !== null || clientLocked;

  // Latest-locked ref so the committing setters can reject a mutation once the
  // selection is locked (belt-and-braces — the UI already renders the pickers
  // read-only, and the per-conversation pin-hydration effect must not override a
  // binding). Seeded from the first render and kept in sync via an effect.
  const lockedRef = React.useRef(selectionLocked);
  React.useEffect(() => {
    lockedRef.current = selectionLocked;
  }, [selectionLocked]);

  // Persist in the committing setter (never a key-scoped effect) so switching
  // conversations can't write the previous chat's agent under the new key.
  const commitAgentId = React.useCallback(
    (id: string | null) => {
      if (lockedRef.current) return;
      setSelectedAgentId(id);
      writeStoredAgentId(agentStorageKey(workspaceSlug, conversationId), id);
    },
    [workspaceSlug, conversationId],
  );

  // Latest-repo ref so the org→repo→branch cascade can compare against the
  // current repo without a setState updater (updaters must stay pure).
  const repoKeyRef = React.useRef(selectedRepoKey);
  React.useEffect(() => {
    repoKeyRef.current = selectedRepoKey;
  }, [selectedRepoKey]);

  const setRepoKeyGuarded = React.useCallback((key: string | null) => {
    if (lockedRef.current) return;
    // Cascade (mirrors `applySessionPatch`): a new repo invalidates the branch.
    if (key !== repoKeyRef.current) setSelectedBranch(null);
    repoKeyRef.current = key;
    setSelectedRepoKey(key);
  }, []);
  const setEnvIdGuarded = React.useCallback((id: string | null) => {
    if (lockedRef.current) return;
    setSelectedEnvId(id);
  }, []);

  const applyAgentSelection = React.useCallback(
    (sel: AgentSelectionApply) => {
      if (lockedRef.current) return;
      commitAgentId(sel.agentId);
      if (sel.repoKey !== undefined) {
        // The apply is atomic: an explicit branch in the SAME apply is the
        // user's choice for the new repo and wins over the cascade reset.
        if (sel.repoKey !== repoKeyRef.current && sel.branch === undefined) {
          setSelectedBranch(null);
        }
        repoKeyRef.current = sel.repoKey;
        setSelectedRepoKey(sel.repoKey);
      }
      if (sel.branch !== undefined) setSelectedBranch(sel.branch);
      if (sel.envId !== undefined) setSelectedEnvId(sel.envId);
    },
    [commitAgentId],
  );

  const lockSelection = React.useCallback(() => setClientLocked(true), []);

  // A server binding is the source of truth — force the selection onto it
  // (idempotent) whenever the binding's values change. Primitive deps keep this
  // from re-firing every RSC render (the binding object identity churns each
  // render; its field values don't).
  React.useEffect(() => {
    if (!codeBinding) return;
    setSelectedAgentId(codeBinding.agentId);
    setSelectedRepoKey(boundRepoKey);
    setSelectedEnvId(codeBinding.environmentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- force to primitive binding values; the object identity churns each render
  }, [codeBinding?.agentId, boundRepoKey, codeBinding?.environmentId]);

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

    // A server binding owns the selection (forced by the effect above) — never
    // re-resolve it from prefs/persistence for a locked conversation.
    if (codeBinding) return;

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
      selectedBranch,
      selectedEnvId,
      selectionLocked,
      setSelectedAgentId: commitAgentId,
      setSelectedRepoKey: setRepoKeyGuarded,
      setSelectedEnvId: setEnvIdGuarded,
      applyAgentSelection,
      lockSelection,
    }),
    [
      selectedAgentId,
      selectedRepoKey,
      selectedBranch,
      selectedEnvId,
      selectionLocked,
      commitAgentId,
      setRepoKeyGuarded,
      setEnvIdGuarded,
      applyAgentSelection,
      lockSelection,
    ],
  );

  return (
    <ChatSelectionContext.Provider value={store}>
      {children}
    </ChatSelectionContext.Provider>
  );
}
