/**
 * recent-agents.ts — per-workspace recency for the chat_ux_v2 agent picker's
 * "Recent" row (agent-picker-panel.tsx). Read once on picker mount, pushed to
 * whenever an agent gets applied, capped at `MAX_RECENT_AGENTS` so the row
 * never needs to scroll.
 *
 * Never throws — a disabled/unavailable localStorage (private mode, quota)
 * just means recency doesn't persist across reloads, mirroring the degrade
 * pattern in `agent-context.ts` / `session-store.tsx`.
 */

const KEY_ROOT = "oxagen:chat-session:v1:recent-agents";

/** Row cap — also the localStorage list's max length. */
export const MAX_RECENT_AGENTS = 5;

/** localStorage key for a workspace's recent-agent list. */
export function recentAgentsKey(workspaceSlug: string | undefined): string {
  return `${KEY_ROOT}:${workspaceSlug ?? "_"}`;
}

/**
 * Read the persisted recent-agent id list (most-recent-first) for a
 * workspace. Returns `[]` for no storage, malformed JSON, a non-array value,
 * or an unavailable/disabled store.
 */
export function readRecentAgentIds(workspaceSlug: string | undefined): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentAgentsKey(workspaceSlug));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/**
 * Record `agentId` as the most recently used agent for this workspace: moves
 * it to the front (de-duping any earlier occurrence) and caps the list at
 * `MAX_RECENT_AGENTS`. Returns the updated list so the caller can update its
 * render without a second read.
 */
export function pushRecentAgentId(
  workspaceSlug: string | undefined,
  agentId: string,
): string[] {
  const next = [
    agentId,
    ...readRecentAgentIds(workspaceSlug).filter((id) => id !== agentId),
  ].slice(0, MAX_RECENT_AGENTS);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(recentAgentsKey(workspaceSlug), JSON.stringify(next));
    } catch {
      // Storage unavailable — recency just doesn't persist across reloads.
    }
  }
  return next;
}
