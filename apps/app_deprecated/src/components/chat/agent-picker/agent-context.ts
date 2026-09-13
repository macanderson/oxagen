/**
 * agent-context.ts — persistence + initial-resolution for the chat's selected
 * agent, the agent-selection analogue of `pinned-context.ts`.
 *
 * The selected agent is the user's explicit "for this conversation, chat with
 * THIS agent" choice. Once chosen it is (a) persisted in localStorage so it
 * survives reloads, and (b) sent on every turn as `agentId` (the composer's
 * existing wire field). Selection is optional — the "Default assistant" option
 * clears it back to the generic chat agent.
 *
 * Persistence is keyed per-conversation. A brand-new chat has no conversation
 * id yet, so its selection is stored under a workspace-scoped DRAFT key and
 * migrated onto the real conversation key the moment the first turn creates the
 * conversation (mirrors the pinned-context draft→conversation migration).
 */

const KEY_ROOT = "oxagen:chat-agent";
export const DRAFT_PREFIX = `${KEY_ROOT}:draft:`;

/**
 * localStorage key for a conversation's selected agent. Uses the conversation
 * id when the conversation exists, else a workspace-scoped draft key for the
 * not-yet-sent new chat.
 */
export function agentStorageKey(
  workspaceSlug: string | undefined,
  conversationId: string | null,
): string {
  if (conversationId) return `${KEY_ROOT}:conv:${conversationId}`;
  return `${DRAFT_PREFIX}${workspaceSlug ?? "_"}`;
}

/**
 * Read the persisted agent public id (`agt_…`) for a conversation key, or null
 * when nothing is stored / storage is unavailable. Never throws.
 */
export function readStoredAgentId(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    // Stored as a bare id string; guard against a stored JSON value instead.
    if (raw.startsWith("{") || raw.startsWith("[")) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Persist (or clear, when `agentId` is null) the selected agent for a
 * conversation key. Silently degrades to in-memory-only when storage is
 * unavailable (private mode / quota / disabled).
 */
export function writeStoredAgentId(key: string, agentId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (agentId) window.localStorage.setItem(key, agentId);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage disabled — selection just doesn't persist across reloads.
  }
}

/** Inputs to `resolveInitialAgentId`. Each id is an agent public id (`agt_…`). */
export interface ResolveInitialAgentInput {
  /** URL `?agent=` binding (the Ask page's session binding). Highest priority. */
  boundAgentId: string | null;
  /** Per-conversation persisted selection (localStorage). Client-only. */
  persistedAgentId: string | null;
  /** The workspace user's default agent preference. */
  workspaceDefaultAgentId: string | null;
  /** True when this is a brand-new conversation (no messages / no id yet). */
  isNewConversation: boolean;
}

/**
 * Resolve which agent a conversation should open with, in strict priority
 * order — the single place this decision lives so it can be unit-tested:
 *
 *   1. URL `?agent=` binding — an explicit session binding always wins.
 *   2. Per-conversation persisted selection — the user's last choice here.
 *   3. Workspace default agent — but ONLY for a brand-new conversation, so an
 *      existing thread isn't retroactively rebound when the user later sets a
 *      workspace default.
 *   4. None — the generic "Default assistant".
 *
 * Returns the resolved agent public id, or null for the default assistant.
 */
export function resolveInitialAgentId(
  input: ResolveInitialAgentInput,
): string | null {
  if (input.boundAgentId) return input.boundAgentId;
  if (input.persistedAgentId) return input.persistedAgentId;
  if (input.isNewConversation && input.workspaceDefaultAgentId) {
    return input.workspaceDefaultAgentId;
  }
  return null;
}
