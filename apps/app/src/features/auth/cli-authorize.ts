// /cli/authorize: the authorize leg of the CLI's RFC 8252 loopback OAuth + PKCE
// login, carried over from apps/app_deprecated/src/app/cli/authorize.
//
// Security invariants (unchanged from the deprecated app):
//   1. A bad redirect_uri is never followed, not even to report an error
//      (RFC 8252 §7.3): parameter errors render inline.
//   2. Every parameter is re-validated in the approve action; nothing from the
//      client is trusted, and slugs resolve to ids server-side.
//   3. Workspace membership and the API-key management permission are checked
//      explicitly, because apps/app does not bootstrap IAM for these reads.
import "server-only";
import {
  CLI_AUTH_PKCE_METHOD,
  isLoopbackRedirectUri,
  isValidCodeChallenge,
} from "@oxagen/auth/cli-auth";
import { isFixtureMode } from "@/server/fixture-session";
import { FIXTURE_ORG, FIXTURE_WORKSPACE } from "./fixture";
import { firstParam } from "./safe-next";

export type CliAuthorizeParams = {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  label: string;
};

export type CliParamError =
  | "redirectUri"
  | "codeChallenge"
  | "codeChallengeMethod"
  | "state";

export type WorkspaceOption = { id: string; slug: string; name: string };
export type OrgOption = {
  id: string;
  slug: string;
  name: string;
  workspaces: WorkspaceOption[];
};

export const DEFAULT_CLI_LABEL = "Oxagen CLI";

type SearchParams = Record<string, string | string[] | undefined>;

export function readAuthorizeParams(params: SearchParams): CliAuthorizeParams {
  const label = (firstParam(params.label) ?? "").trim().slice(0, 120);
  return {
    redirectUri: firstParam(params.redirect_uri) ?? "",
    state: firstParam(params.state) ?? "",
    codeChallenge: firstParam(params.code_challenge) ?? "",
    codeChallengeMethod: firstParam(params.code_challenge_method) ?? "",
    label: label || DEFAULT_CLI_LABEL,
  };
}

export function authorizeParamErrors(p: CliAuthorizeParams): CliParamError[] {
  const errors: CliParamError[] = [];
  if (!isLoopbackRedirectUri(p.redirectUri)) errors.push("redirectUri");
  if (!isValidCodeChallenge(p.codeChallenge)) errors.push("codeChallenge");
  if (p.codeChallengeMethod !== CLI_AUTH_PKCE_METHOD)
    errors.push("codeChallengeMethod");
  if (!p.state) errors.push("state");
  return errors;
}

/** The query string that brings a signed-out person back to this exact request after logging in. */
export function authorizeReturnPath(p: CliAuthorizeParams): string {
  const query = new URLSearchParams({
    redirect_uri: p.redirectUri,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: p.codeChallengeMethod,
    label: p.label,
  });
  return `/cli/authorize?${query.toString()}`;
}

/** Group org and workspace memberships into the picker's shape, keeping only workspaces of orgs the user belongs to. */
export function groupScopes(
  orgs: ReadonlyArray<{ id: string; slug: string; name: string }>,
  workspaces: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    orgId: string;
  }>,
): OrgOption[] {
  const byOrg = new Map<string, OrgOption>();
  for (const org of orgs) byOrg.set(org.id, { ...org, workspaces: [] });
  const seen = new Set<string>();
  for (const ws of workspaces) {
    const org = byOrg.get(ws.orgId);
    if (!org || seen.has(ws.id)) continue;
    seen.add(ws.id);
    org.workspaces.push({ id: ws.id, slug: ws.slug, name: ws.name });
  }
  return [...byOrg.values()].filter((o) => o.workspaces.length > 0);
}

/** The orgs and member workspaces a user can authorize the CLI against. */
export async function loadCliScopes(userId: string): Promise<OrgOption[]> {
  if (isFixtureMode()) {
    return [
      {
        id: "org_fixture_acme",
        slug: FIXTURE_ORG.slug,
        name: FIXTURE_ORG.name,
        workspaces: [
          {
            id: "wrk_fixture_core",
            slug: FIXTURE_WORKSPACE.slug,
            name: FIXTURE_WORKSPACE.name,
          },
        ],
      },
    ];
  }
  const { withSystemDb } = await import("@oxagen/database");
  // tenancy: unscoped seam (cross-tenant identity resolution before a scope exists;
  // every row is filtered to the signed-in user's own memberships)
  return withSystemDb(async (tx) => {
    const orgMemberships = await tx.query.orgUsers.findMany({
      where: (ou, { eq }) => eq(ou.userId, userId),
      columns: { orgId: true },
    });
    const wsMemberships = await tx.query.workspaceUsers.findMany({
      where: (wu, { eq }) => eq(wu.userId, userId),
      columns: { workspaceId: true },
    });
    const orgIds = orgMemberships.map((m) => m.orgId);
    const wsIds = wsMemberships.map((m) => m.workspaceId);
    if (orgIds.length === 0 || wsIds.length === 0) return [];
    const [orgs, workspaces] = await Promise.all([
      tx.query.organizations.findMany({
        where: (o, { inArray }) => inArray(o.id, orgIds),
        columns: { id: true, slug: true, name: true },
      }),
      tx.query.workspaces.findMany({
        where: (w, { and, inArray }) =>
          and(inArray(w.id, wsIds), inArray(w.orgId, orgIds)),
        columns: { id: true, slug: true, name: true, orgId: true },
      }),
    ]);
    return groupScopes(orgs, workspaces);
  });
}
