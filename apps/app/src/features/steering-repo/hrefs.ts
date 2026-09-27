// The API routes that connect an organization's steering host. They live on the
// API (apps/api/src/routes/v1/gitlab-oauth.ts mounts them at
// `/v1/:org_slug/connections/steering`), and the browser reaches them
// same-origin through the app's `/api/v1/*` rewrite with the session cookie, as
// the assistant's chat stream does.
import type { SafePath } from "@/shared/safe-path";

/**
 * `steering` is Oxagen Steering, the app that creates and administers steering
 * repos. `oxagen` is the Oxagen app that works on code repositories.
 * `install` opens the app's install page, and `authorize` opens GitHub's
 * authorization page for an app already installed (Re-authorize).
 */
export type SteeringGithubLeg =
  | { app: "steering"; mode: "install" | "authorize" }
  | { app: "oxagen"; mode: "install" };

/**
 * `GET /api/v1/{org}/connections/steering/github`: the API signs the state and
 * redirects to GitHub. GitHub returns to `/oauth/github/steering` (Oxagen
 * Steering) or `/oauth/github` (Oxagen), which sends the person to `returnTo`.
 */
export function steeringGithubHref(
  org: string,
  leg: SteeringGithubLeg,
  returnTo: SafePath,
): string {
  const query = new URLSearchParams({
    app: leg.app,
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
