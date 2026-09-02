/**
 * Pinned chat context — the persistence + wire layer for "pin an org/repo and
 * environment to this chat".
 *
 * A pin is the user's explicit commit that "for this conversation, THIS is the
 * repository/environment I mean". Once pinned it is (a) persisted in
 * localStorage so it survives reloads, and (b) sent on every turn as
 * `pinnedContext` so the agent resolves which repo/env the user means without
 * asking. Pinning is optional and repo/environment are independent — a chat can
 * pin only a repo, only an environment, both, or neither.
 *
 * Persistence is keyed per-conversation. A brand-new chat has no conversation
 * id yet, so its pin is stored under a workspace-scoped DRAFT key and migrated
 * onto the real conversation key the moment the first turn creates the
 * conversation (see the composer's hydration effect).
 */
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";

/** The wire shape sent to the stream route as `pinnedContext`. */
export interface PinnedContextPayload {
  repo: {
    connectionId: string;
    owner: string;
    name: string;
    defaultBranch: string | null;
  } | null;
  environment: { id: string; name: string } | null;
}

/** What we persist: the selector KEYS, re-resolved against the live options. */
export interface StoredPins {
  repoKey: string | null;
  envId: string | null;
}

const KEY_ROOT = "oxagen:chat-pins";
export const DRAFT_PREFIX = `${KEY_ROOT}:draft:`;

/**
 * localStorage key for a conversation's pins. Uses the conversation id when the
 * conversation exists, else a workspace-scoped draft key for the not-yet-sent
 * new chat.
 */
export function pinStorageKey(
  workspaceSlug: string | undefined,
  conversationId: string | null,
): string {
  if (conversationId) return `${KEY_ROOT}:conv:${conversationId}`;
  return `${DRAFT_PREFIX}${workspaceSlug ?? "_"}`;
}

export function readStoredPins(key: string): StoredPins | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      repoKey: typeof obj.repoKey === "string" ? obj.repoKey : null,
      envId: typeof obj.envId === "string" ? obj.envId : null,
    };
  } catch {
    return null;
  }
}

export function writeStoredPins(key: string, pins: StoredPins | null): void {
  if (typeof window === "undefined") return;
  try {
    if (pins && (pins.repoKey || pins.envId)) {
      window.localStorage.setItem(key, JSON.stringify(pins));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Private-mode / quota / disabled storage — pinning silently degrades to
    // in-memory-only for the session rather than throwing.
  }
}

/**
 * Build the `pinnedContext` wire payload from the resolved repo/environment
 * options, or `null` when neither is set (nothing to pin).
 */
export function buildPinnedContext(
  repo: RepoOption | null,
  environment: EnvironmentOption | null,
): PinnedContextPayload | null {
  if (!repo && !environment) return null;
  return {
    repo: repo
      ? {
          connectionId: repo.connectionId,
          owner: repo.owner,
          name: repo.name,
          defaultBranch: repo.defaultBranch,
        }
      : null,
    environment: environment
      ? { id: environment.id, name: environment.name }
      : null,
  };
}
