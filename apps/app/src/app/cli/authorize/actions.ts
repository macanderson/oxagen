"use server";
/**
 * CLI browser-login consent actions — RFC 8252 loopback OAuth + PKCE.
 *
 * Two server actions are exported:
 *   - approveCliAuth: validates the session + submitted params, checks org/workspace
 *     membership and the API-key management permission, mints a single-use
 *     authorization code, and redirects the browser to the CLI's loopback listener.
 *   - cancelCliAuth: redirects with error=access_denied (user cancelled).
 *
 * Security invariants enforced here:
 *   1. redirect_uri is re-validated every time with isLoopbackRedirectUri — the
 *      page never follows an attacker-controlled destination.
 *   2. code_challenge is re-validated on approve — the code is always bound to
 *      a challenge the CLI generated, never a blank or crafted value.
 *   3. slug → id resolution is always server-side; IDs from the client are ignored.
 *   4. Workspace membership is asserted (query, not just id presence).
 *   5. actorCanManageApiKeys gates the approve path — only Owner/Admin may authorize
 *      a CLI key (mirrors the api.key.create handler's authz gate).
 *   6. apps/app does NOT bootstrap IAM, so checks 4 + 5 are explicit here
 *      and cannot be accidentally skipped by the kernel.
 */

import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSession } from "@/lib/session";
import {
  generateCliAuthCode,
  createCliAuthCode,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
  CLI_AUTH_PKCE_METHOD,
} from "@oxagen/auth/cli-auth";
import { actorCanManageApiKeys } from "@oxagen/handlers";

// Sentinel workspace ID for org-level queries (no real workspace context).
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve org + workspace from slugs using withSystemDb (RLS-bypassing,
 * deliberate — this is a slug→id lookup before a tenant scope exists).
 * Returns null when either slug is unknown.
 */
export async function resolveCliAuthScope(
  orgSlug: string,
  workspaceSlug: string,
): Promise<{ orgId: string; workspaceId: string } | null> {
  const orgRows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.slug, orgSlug))
      .limit(1),
  );
  const org = orgRows[0];
  if (!org) return null;

  const wsRows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.orgId, org.id),
          eq(schema.workspaces.slug, workspaceSlug),
        ),
      )
      .limit(1),
  );
  const ws = wsRows[0];
  if (!ws) return null;

  return { orgId: org.id, workspaceId: ws.id };
}

/**
 * Assert the user is a member of the workspace via workspace_users.
 * Returns true on membership, false on any failure.
 */
export async function assertCliWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = await withSystemDb((tx) =>
    tx
      .select({ id: schema.workspaceUsers.id })
      .from(schema.workspaceUsers)
      .where(
        and(
          eq(schema.workspaceUsers.workspaceId, workspaceId),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// approveCliAuth
// ---------------------------------------------------------------------------

/**
 * The user clicked "Approve" on the consent form. Re-validates all security-
 * critical params (never trusting client-supplied values), checks membership
 * and API-key management permission, mints a single-use code, and redirects
 * the browser to the CLI's loopback listener with code + state.
 *
 * FormData fields expected:
 *   redirect_uri, state, code_challenge, code_challenge_method,
 *   label, org_slug, workspace_slug
 */
export async function approveCliAuth(formData: FormData): Promise<void> {
  // --- 1. Re-read session ---------------------------------------------------
  const session = await getSession();
  if (!session?.user) {
    redirect("/login");
  }
  const userId = session.user.id;

  // --- 2. Re-read and re-validate all params --------------------------------
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");
  const codeChallenge = String(formData.get("code_challenge") ?? "");
  const codeChallengeMethod = String(
    formData.get("code_challenge_method") ?? "",
  );
  const label = String(formData.get("label") ?? "Oxagen CLI");
  const orgSlug = String(formData.get("org_slug") ?? "");
  const workspaceSlug = String(formData.get("workspace_slug") ?? "");

  // Security: re-validate every param, never follow an unvalidated redirect_uri.
  if (!isLoopbackRedirectUri(redirectUri)) {
    throw new Error("Invalid redirect_uri");
  }
  if (!isValidCodeChallenge(codeChallenge)) {
    throw new Error("Invalid code_challenge");
  }
  if (codeChallengeMethod !== CLI_AUTH_PKCE_METHOD) {
    throw new Error("Invalid code_challenge_method");
  }
  if (!state) {
    throw new Error("Missing state");
  }
  if (!orgSlug || !workspaceSlug) {
    throw new Error("Missing org or workspace selection");
  }

  // --- 3. Resolve slug → id (server-side, never trust client IDs) -----------
  const scope = await resolveCliAuthScope(orgSlug, workspaceSlug);
  if (!scope) {
    throw new Error("Workspace not found");
  }
  const { orgId, workspaceId } = scope;

  // --- 4. Assert workspace membership ---------------------------------------
  const isMember = await assertCliWorkspaceMember(workspaceId, userId);
  if (!isMember) {
    throw new Error("You are not a member of this workspace");
  }

  // --- 5. Assert API-key management permission (Owner/Admin) ---------------
  // actorCanManageApiKeys uses withTenantDb; wrap in runInTenantScope.
  const canManage = await runInTenantScope(
    { orgId, workspaceId: ORG_ONLY_WS },
    () => actorCanManageApiKeys(orgId, userId),
  );
  if (!canManage) {
    throw new Error(
      "You need permission to create API keys in this workspace. Ask an Owner or Admin to authorize the CLI.",
    );
  }

  // --- 6. Mint code + redirect to loopback ---------------------------------
  const code = generateCliAuthCode();
  await createCliAuthCode(
    code,
    {
      userId,
      orgId,
      workspaceId,
      orgSlug,
      workspaceSlug,
      codeChallenge,
      redirectUri,
      label,
    },
    Date.now(),
  );

  redirect(
    `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
  );
}

// ---------------------------------------------------------------------------
// cancelCliAuth
// ---------------------------------------------------------------------------

/**
 * The user clicked "Cancel". Re-validates the redirect_uri and sends the
 * browser back to the CLI listener with error=access_denied.
 *
 * FormData fields expected: redirect_uri, state
 */
export async function cancelCliAuth(formData: FormData): Promise<void> {
  const redirectUri = String(formData.get("redirect_uri") ?? "");
  const state = String(formData.get("state") ?? "");

  // Security: only redirect to a validated loopback URI.
  if (!isLoopbackRedirectUri(redirectUri)) {
    throw new Error("Invalid redirect_uri");
  }

  redirect(
    `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`,
  );
}
