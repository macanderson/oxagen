// The API routes that connect an organization's steering host. They live on the
// API (apps/api/src/routes/v1/gitlab-oauth.ts mounts them at
// `/v1/:org_slug/connections/steering`), and the browser reaches them
// same-origin through the app's `/api/v1/*` rewrite with the session cookie, as
// the assistant's chat stream does.
import type { SafePath } from "@/shared/safe-path";

/**
 * GitHub has one Oxagen app, which creates steering repos and works on code
 * repositories (ADR-228). `install` opens the app's install page, which
 * installs it on a GitHub organization and authorizes the person in one pass.
 * `authorize` opens GitHub's authorization page. It is the way back for an
 * organization that already has the app, because GitHub's install page then
 * shows Configure, which drops the signed state (Re-authorize).
 */
export type SteeringGithubLeg = { mode: "install" | "authorize" };

/**
 * `GET /api/v1/{org}/connections/steering/github`: the API signs the state and
 * redirects to GitHub. Both legs return through the app's one callback,
 * `/oauth/github/callback`, which sends the person to `returnTo` with
 * `?steering=connected` or `?steering=error&code=`.
 */
export function steeringGithubHref(
  org: string,
  leg: SteeringGithubLeg,
  returnTo: SafePath,
): string {
  const query = new URLSearchParams({
    mode: leg.mode,
    return_to: returnTo,
  });
  return `/api/v1/${encodeURIComponent(org)}/connections/steering/github?${query.toString()}`;
}

/**
 * `POST /api/v1/{org}/connections/steering/gitlab` with the JSON body
 * `{ group, token }`: a GitLab group's path and a group access token with the
 * `api` scope and the Maintainer role. It answers `{ group_id, group_path }`.
 */
export function steeringGitlabPath(org: string): string {
  return `/api/v1/${encodeURIComponent(org)}/connections/steering/gitlab`;
}
