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
import { eq, and } from "drizzle-orm";
import { withSystemDb, schema } from "@oxagen/database";
import { getSession } from "@/lib/session";
import {
  CLI_AUTH_PKCE_METHOD,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
} from "@oxagen/auth/cli-auth";
import { ConsentForm } from "./consent-form";
import type { OrgOption } from "./consent-form";

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
  const session = await getSession();
  if (!session?.user) {
    const returnTo =
      `/cli/authorize?` +
      new URLSearchParams({
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        label,
      }).toString();
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  const userId = session.user.id;

  // --- 3. Load user's orgs + member workspaces -----------------------------
  // withSystemDb bypasses RLS (deliberate — cross-tenant identity resolution
  // before a tenant scope exists; same pattern as the root page). The join on
  // workspaceUsers ensures the list only contains workspaces the user can
  // actually access.
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        orgId: schema.organizations.id,
        orgSlug: schema.organizations.slug,
        orgName: schema.organizations.name,
        workspaceId: schema.workspaces.id,
        workspaceSlug: schema.workspaces.slug,
        workspaceName: schema.workspaces.name,
      })
      .from(schema.orgUsers)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgUsers.orgId),
      )
      .innerJoin(
        schema.workspaceUsers,
        and(
          eq(schema.workspaceUsers.userId, userId),
          eq(schema.workspaceUsers.userId, schema.orgUsers.userId),
        ),
      )
      .innerJoin(
        schema.workspaces,
        and(
          eq(schema.workspaces.id, schema.workspaceUsers.workspaceId),
          eq(schema.workspaces.orgId, schema.organizations.id),
        ),
      )
      .where(eq(schema.orgUsers.userId, userId)),
  );

  // Group rows into org → workspaces structure.
  const orgMap = new Map<
    string,
    {
      id: string;
      slug: string;
      name: string;
      workspaces: { id: string; slug: string; name: string }[];
    }
  >();
  for (const row of rows) {
    if (!orgMap.has(row.orgId)) {
      orgMap.set(row.orgId, {
        id: row.orgId,
        slug: row.orgSlug,
        name: row.orgName,
        workspaces: [],
      });
    }
    const org = orgMap.get(row.orgId)!;
    // Avoid duplicate workspace entries (the join can produce them if a user
    // has multiple org_users rows, which shouldn't happen but guard anyway).
    if (!org.workspaces.some((w) => w.id === row.workspaceId)) {
      org.workspaces.push({
        id: row.workspaceId,
        slug: row.workspaceSlug,
        name: row.workspaceName,
      });
    }
  }

  const orgs: OrgOption[] = Array.from(orgMap.values());

  if (orgs.length === 0) {
    return (
      <ParamErrorPage
        errors={[
          "No organizations or workspaces found for your account. Create a workspace before authorizing the CLI.",
        ]}
      />
    );
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
