/**
 * code-session-defaults.ts — pure helpers that resolve a workspace user's
 * saved coding defaults (from `get_workspace_user_preferences`) to the live
 * selector values the code-agent session setup prefills with.
 *
 * Dependency-free (no React, no "use client") so both the server data path
 * (`chat-shell.tsx`) and the client provider can import them.
 */
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

/**
 * Resolve the workspace user's default repo (connection + `owner/repo` slug) to
 * a live `RepoOption.key`, or null when no default is set or it no longer maps
 * to an available repo.
 */
export function resolveDefaultRepoKey(
  repos: readonly RepoOption[],
  defaultRepoConnectionId: string | null,
  defaultRepoSlug: string | null,
): string | null {
  if (!defaultRepoConnectionId || !defaultRepoSlug) return null;
  const match = repos.find(
    (r) =>
      r.connectionId === defaultRepoConnectionId &&
      `${r.owner}/${r.name}` === defaultRepoSlug,
  );
  return match?.key ?? null;
}

/**
 * Resolve the default environment id: the user's preferred default when it
 * still exists, else the workspace's `isDefault` environment, else null.
 */
export function resolveDefaultEnvId(
  environments: readonly EnvironmentOption[],
  defaultEnvironmentId: string | null,
): string | null {
  if (
    defaultEnvironmentId &&
    environments.some((e) => e.id === defaultEnvironmentId)
  ) {
    return defaultEnvironmentId;
  }
  return environments.find((e) => e.isDefault)?.id ?? null;
}
