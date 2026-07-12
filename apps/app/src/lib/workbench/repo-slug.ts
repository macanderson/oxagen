/**
 * repo-slug.ts — pure `owner/repo` parsing, shared by the server-only
 * lib/workbench/repos.ts wrapper AND client components (repos-client.tsx,
 * the repo-detail tabs). No server imports here — this file must stay safe
 * to bundle into the client.
 */

/**
 * Derive `{ owner, repo }` from a GitHub connection's displayName, which
 * connection.mappings.set always sets to `owner/repo` (optionally suffixed
 * `" (+N more)"` for a multi-repo selection — the primary repo is the one
 * this UI's owner/repo-scoped actions (branches, PRs, files, agent edit)
 * operate against). Returns null when the connection hasn't resolved a repo
 * yet (e.g. displayName is still the literal "GitHub" from a pending_setup
 * install) — callers must treat null as "repo not yet configured".
 */
export function parseRepoSlug(
  displayName: string,
): { owner: string; repo: string } | null {
  const primary = displayName.replace(/\s*\(\+\d+ more\)\s*$/, "").trim();
  const slash = primary.indexOf("/");
  if (slash <= 0 || slash === primary.length - 1) return null;
  const owner = primary.slice(0, slash).trim();
  const repo = primary.slice(slash + 1).trim();
  if (!owner || !repo) return null;
  return { owner, repo };
}
