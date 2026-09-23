// The pure core of requireViewer: given a session and the tenancy lookups,
// decide whether this person may see /{org}[/{ws}], and as whom. No Next
// imports, no I/O of its own, so every branch has a unit test. viewer.ts mints
// the context from the fields an `ok` result carries.
//
// Order matters for what a stranger can learn:
//   1. no session                       → unauthenticated
//   2. malformed slug                   → not_found (no lookup spent)
//   3. unknown org, or not a member     → not_found (never a hint the org exists;
//                                         membership is checked BEFORE a stale-slug
//                                         redirect, so a rename is not disclosed either)
//   4. a role outside the stored set    → not_found (fail closed)
//   5. unknown workspace, not a member of it, or a workspace role outside the
//      stored set → not_found (fail closed, as for the org role)
//   6. SSO required, session not one of
//      the org's verified providers     → sso_required (owners exempt)
//   7. MFA policy requires enrollment   → mfa_enroll
//   8. a historical slug                → redirect to the canonical slugs
//   9. otherwise                        → the viewer's fields
//
// SSO comes before MFA: a person who must sign in again through the identity
// provider gains nothing from an enrollment prompt on the session being
// replaced.
import { evaluateMfaGate, mfaGateApplies } from "./mfa-gate";
import type { AppSession } from "./session";
import { evaluateSsoGate, ssoGateApplies } from "./sso-gate";
import type { SystemLookups } from "./tenancy-lookups";
import type { OrgFields, OrgRole, WsFields } from "./viewer";

export type ViewerResolution =
  | {
      kind: "ok";
      org: OrgFields;
      ws: Omit<WsFields, keyof OrgFields> | null;
    }
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "mfa_enroll" }
  | { kind: "sso_required" }
  | { kind: "redirect"; org: string; ws: string | null };

/**
 * Every role a membership CHECK admits, and nothing else. `org_users.role` and
 * `workspace_users.role` carry the same six values, so one table judges both.
 */
const MEMBERSHIP_ROLES = {
  owner: true,
  admin: true,
  member: true,
  billing: true,
  compliance: true,
  viewer: true,
} as const satisfies Record<OrgRole, true>;

function isMembershipRole(role: string): role is OrgRole {
  return Object.hasOwn(MEMBERSHIP_ROLES, role);
}

/**
 * The slug format org and workspace create/rename validate against. A value
 * that fails it (favicon.ico, robots.txt falling through to [org]) was never a
 * slug, so it 404s without a database round trip.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isValidSlug(value: string): boolean {
  return value.length <= 128 && SLUG_PATTERN.test(value);
}

export type ResolveViewerDeps = {
  session: AppSession | null;
  lookups: SystemLookups;
  now: Date;
};

export async function resolveViewerWith(
  deps: ResolveViewerDeps,
  orgSlug: string,
  wsSlug?: string,
): Promise<ViewerResolution> {
  const { session, lookups } = deps;
  if (!session) return { kind: "unauthenticated" };
  const userId = session.user.id;

  if (!isValidSlug(orgSlug)) return { kind: "not_found" };
  if (wsSlug !== undefined && !isValidSlug(wsSlug))
    return { kind: "not_found" };

  const org =
    (await lookups.orgBySlug(orgSlug)) ??
    (await lookups.orgBySlugHistory(orgSlug));
  if (!org) return { kind: "not_found" };

  const role = await lookups.orgRole(org.id, userId);
  if (role === null || !isMembershipRole(role)) return { kind: "not_found" };

  let ws: Extract<ViewerResolution, { kind: "ok" }>["ws"] = null;
  if (wsSlug !== undefined) {
    const found =
      (await lookups.workspaceBySlug(org.id, wsSlug)) ??
      (await lookups.workspaceBySlugHistory(org.id, wsSlug));
    if (!found || found.orgId !== org.id) return { kind: "not_found" };
    // The membership is the workspace gate and the role it carries is the
    // viewer's authority inside it (#3143). A role the CHECK would not admit is
    // treated exactly as the org role is: not a member, so not_found.
    const member = await lookups.workspaceMember(found.id, userId);
    if (member === null || !isMembershipRole(member.role))
      return { kind: "not_found" };
    ws = {
      workspaceId: found.id,
      wsSlug: found.slug,
      wsName: found.name,
      wsRole: member.role,
    };
  }

  // Both policies live on one org row; read them together, not in series.
  const [sso, policy] = await Promise.all([
    lookups.ssoPolicy(org.id),
    lookups.mfaPolicy(org.id),
  ]);
  if (ssoGateApplies(role, sso)) {
    const decision = evaluateSsoGate({
      role,
      policy: sso,
      authMethod: session.authMethod ?? null,
    });
    if (decision.action === "sso") return { kind: "sso_required" };
  }

  if (mfaGateApplies(role, policy)) {
    const decision = evaluateMfaGate({
      role,
      policy,
      twoFactorEnabled: await lookups.twoFactorEnabled(userId),
      now: deps.now,
    });
    if (decision.action === "enroll") return { kind: "mfa_enroll" };
  }

  if (org.slug !== orgSlug || (ws !== null && ws.wsSlug !== wsSlug)) {
    return { kind: "redirect", org: org.slug, ws: ws?.wsSlug ?? null };
  }

  return {
    kind: "ok",
    org: {
      userId,
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name,
      orgRole: role,
    },
    ws,
  };
}

/**
 * The canonical URL for a request that arrived on a historical slug.
 *
 * `base` is where the `{org}` segment starts: "/" for pages, "/api/mc/" for the
 * stream route. Only the org and workspace segments at that position are
 * rewritten, so a later path segment that happens to equal an old slug is data
 * and stays. When the path does not have the expected shape, the canonical
 * root for the scope is returned rather than rendering at a stale URL.
 */
export function canonicalPath(input: {
  pathname: string;
  search: string;
  base: "/" | "/api/mc/";
  from: { org: string; ws: string | null };
  to: { org: string; ws: string | null };
}): string {
  const { pathname, search, base, from, to } = input;
  const root = `${base}${to.org}${to.ws ? `/${to.ws}` : ""}`;
  const fromPrefix = `${base}${from.org}${from.ws ? `/${from.ws}` : ""}`;
  if (pathname === fromPrefix) return `${root}${search}`;
  if (pathname.startsWith(`${fromPrefix}/`)) {
    return `${root}${pathname.slice(fromPrefix.length)}${search}`;
  }
  return root;
}
