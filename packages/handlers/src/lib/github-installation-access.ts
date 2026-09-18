// One implementation of "what can this workspace's GitHub authorization
// reach", shared with the two repository capabilities that offer and settle
// the same choice. This file used to carry its own copy of the token lookup
// and the `/user/installations` paging; a second copy of a reachability check
// is a second place for it to drift, and the thing it guards is another
// account's source code.
import {
  GithubUserInstallationsError,
  listUserGithubInstallations,
  resolveWorkspaceGithubUserToken,
} from "../repository.github-user-installations";
import { HTTPException } from "hono/http-exception";

/**
 * Authorization gate for binding a GitHub App installation to a workspace's
 * connection.
 *
 * A GitHub App installation is a shared, singleton-per-account resource, and the
 * Oxagen server holds GITHUB_APP_PRIVATE_KEY — so ANY workspace that writes a
 * valid `installationId` onto a connection can mint an installation token
 * (packages/handlers/src/lib/github-token.ts, ADR-020) and read that org's
 * private repos, REGARDLESS of the acting user's GitHub access. The only thing
 * that makes attaching safe is proving the acting user can actually reach the
 * installation on GitHub. GitHub itself is the oracle: `GET /user/installations`
 * returns exactly the installations the user's OAuth token can see (org
 * membership + granted repo access). We confirm the requested id is in that set;
 * otherwise we refuse the write.
 *
 * Fail-closed: if the workspace has no usable GitHub OAuth token (never
 * connected, or the token was revoked/expired), we cannot verify access, so we
 * reject with an actionable 403 rather than silently allowing the bind. The
 * install/OAuth callback (github-oauth.ts) is exempt — its installationId comes
 * from GitHub's HMAC-verified redirect, not from client input.
 */
export async function assertGithubInstallationAccessible(
  ctx: { orgId: string; workspaceId: string },
  installationId: string | number,
): Promise<void> {
  const targetId = String(installationId);

  // The workspace's org GitHub OAuth token. `oauth_accounts` is org-keyed (one
  // row per GitHub user per org); most-recently-refreshed wins. RLS (org_only)
  // plus the explicit orgId filter bound this to the caller's org. The two
  // failures stay distinguishable because their next clicks differ.
  const token = await resolveWorkspaceGithubUserToken(ctx);
  if (!token.ok) {
    throw new HTTPException(403, {
      message:
        token.reason === "no_account"
          ? "Cannot verify GitHub access for this installation — connect GitHub for this workspace first."
          : "Cannot verify GitHub access for this installation — the stored GitHub token is unreadable; reconnect GitHub.",
    });
  }

  if (!(await userCanReachInstallation(token.accessToken, targetId))) {
    throw new HTTPException(403, {
      message:
        `You do not have access to GitHub installation ${targetId}. ` +
        "Pick an organization the connected GitHub account can access, or install the Oxagen app on it.",
    });
  }
}

/**
 * True if `GET /user/installations` (paged) contains `installationId`. A non-OK
 * GitHub response (revoked or expired token) becomes a 403 — fail-closed: we
 * must not allow the bind when we cannot verify access, and "we could not ask"
 * is never "there is nothing there".
 */
async function userCanReachInstallation(
  userToken: string,
  installationId: string,
): Promise<boolean> {
  let installations;
  try {
    installations = await listUserGithubInstallations(userToken);
  } catch (err) {
    if (err instanceof GithubUserInstallationsError) {
      throw new HTTPException(403, {
        message:
          `Could not verify GitHub installation access (GitHub returned ${err.status}). ` +
          "Reconnect GitHub for this workspace and try again.",
      });
    }
    throw err;
  }
  return installations.some((inst) => inst.installationId === installationId);
}
