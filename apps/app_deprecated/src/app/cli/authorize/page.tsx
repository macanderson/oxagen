/**
 * /cli/authorize — CLI browser-login consent page (RSC, session-gated).
 *
 * Implements the authorize endpoint of an RFC 8252 loopback OAuth + PKCE flow:
 *   1. Validates query params server-side — a bad redirect_uri never results
 *      in a redirect (RFC 8252 §7.3 — render an error inline instead).
 *   2. Requires a session — unauthenticated users are redirected to /login
 *      with a returnTo parameter so they come back here after signing in.
 *   3. Loads the user's orgs and member workspaces; renders <ConsentForm> for
 *      the user to pick a scope and approve or cancel.
 *
 * See actions.ts for the server actions wired to the Approve / Cancel buttons.
 */

import { redirect } from "next/navigation";
import { eq, and, asc } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSession } from "@/lib/session";
import { withReturnTo } from "@/lib/return-to";
import {
  CLI_AUTH_PKCE_METHOD,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
} from "@oxagen/auth/cli-auth";
import { ConsentForm } from "./consent-form";
import { groupCliAuthScopes } from "./scopes";

// ---------------------------------------------------------------------------
// Inline error page (rendered for invalid params — never redirects)
// ---------------------------------------------------------------------------

function ParamErrorPage({ errors }: { errors: string[] }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md rounded-xl border bg-card p-8 shadow-md space-y-4">
        <h1 className="text-xl font-semibold text-destructive">
          Invalid Authorization Request
        </h1>
        <p className="text-sm text-muted-foreground">
          This authorization link is invalid or has expired. Please re-run the
          CLI login command to generate a new link.
        </p>
        <ul className="list-disc list-inside text-sm text-destructive/80 space-y-1">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CliAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  const redirectUri = Array.isArray(params.redirect_uri)
    ? (params.redirect_uri[0] ?? "")
    : (params.redirect_uri ?? "");
  const state = Array.isArray(params.state)
    ? (params.state[0] ?? "")
    : (params.state ?? "");
  const codeChallenge = Array.isArray(params.code_challenge)
    ? (params.code_challenge[0] ?? "")
    : (params.code_challenge ?? "");
  const codeChallengeMethod = Array.isArray(params.code_challenge_method)
    ? (params.code_challenge_method[0] ?? "")
    : (params.code_challenge_method ?? "");
  const label = Array.isArray(params.label)
    ? (params.label[0] ?? "Oxagen CLI")
    : (params.label ?? "Oxagen CLI");

  // --- 1. Validate params BEFORE session check ----------------------------
  // A bad redirect_uri must never be followed, even for an error response
  // (RFC 8252 §7.3 / RFC 6749 §4.1.2.1). Render an inline error instead.
  const errors: string[] = [];

  if (!isLoopbackRedirectUri(redirectUri)) {
    errors.push(
      "redirect_uri must be an HTTP loopback address (127.0.0.1, localhost, or ::1) with an explicit port.",
    );
  }
  if (!isValidCodeChallenge(codeChallenge)) {
    errors.push(
      "code_challenge must be a 43-character base64url-encoded SHA-256 value.",
    );
  }
  if (codeChallengeMethod !== CLI_AUTH_PKCE_METHOD) {
    errors.push(
      `code_challenge_method must be "${CLI_AUTH_PKCE_METHOD}" (S256 is the only supported method).`,
    );
  }
  if (!state) {
    errors.push("state parameter is required.");
  }

  if (errors.length > 0) {
    return <ParamErrorPage errors={errors} />;
  }

  // --- 2. Require session --------------------------------------------------
  // This page's own URL, the `returnTo` every detour (sign-in, second
  // factor, sign-up, new organization) is handed so it ends back here.
  const selfPath =
    `/cli/authorize?` +
    new URLSearchParams({
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      label,
    }).toString();
  const session = await getSession();
  if (!session?.user) {
    redirect(withReturnTo("/login", selfPath));
  }
  const userId = session.user.id;

  // --- 3. Load user's orgs + member workspaces -----------------------------
  // withSystemDb bypasses RLS (deliberate — cross-tenant identity resolution
  // before a tenant scope exists; same pattern as the root page). Every org
  // the user belongs to is a row; a workspace joins in only when the user
  // holds a workspace_users row for it, so the picker offers exactly what the
  // approve action will accept. Both workspace joins are LEFT joins on
  // purpose: an org whose workspaces the user is not a member of still
  // appears, with "No workspaces available", instead of vanishing — an inner
  // join dropped the org itself, and a user with one such org saw a picker
  // for some other org and read it as the wrong account.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.organizations.id,
        orgSlug: schema.organizations.slug,
        orgName: schema.organizations.name,
        workspaceId: schema.workspaces.id,
        workspaceSlug: schema.workspaces.slug,
        workspaceName: schema.workspaces.name,
        membershipId: schema.workspaceUsers.id,
      })
      .from(schema.orgUsers)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgUsers.orgId),
      )
      .leftJoin(
        schema.workspaces,
        eq(schema.workspaces.orgId, schema.organizations.id),
      )
      .leftJoin(
        schema.workspaceUsers,
        and(
          eq(schema.workspaceUsers.workspaceId, schema.workspaces.id),
          eq(schema.workspaceUsers.userId, userId),
        ),
      )
      .where(eq(schema.orgUsers.userId, userId))
      .orderBy(
        asc(schema.organizations.createdAt),
        asc(schema.workspaces.createdAt),
      ),
  );

  const orgs = groupCliAuthScopes(rows);

  // A brand-new account (the installer's "Create an account", or a social
  // sign-up that landed here) has nothing to authorize yet: create the
  // organization and its first workspace, then come back to this consent
  // page with the PKCE parameters intact.
  if (orgs.length === 0) {
    redirect(withReturnTo("/new-organization", selfPath));
  }

  // --- 4. Render consent form ---------------------------------------------
  return (
    <ConsentForm
      label={label}
      redirectUri={redirectUri}
      state={state}
      codeChallenge={codeChallenge}
      orgs={orgs}
    />
  );
}
