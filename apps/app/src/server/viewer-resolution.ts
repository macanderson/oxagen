// The pure core of requireViewer: given a session and the tenancy lookups,
// decide whether this person may see /{org}[/{ws}], and as whom. No Next
// imports, no I/O of its own, so every branch has a unit test.
//
// Order matters for what a stranger can learn:
//   1. no session                       → unauthenticated
//   2. malformed slug                   → not_found (no lookup spent)
//   3. unknown org, or not a member     → not_found (never a hint the org exists;
//                                         membership is checked BEFORE a stale-slug
//                                         redirect, so a rename is not disclosed either)
//   4. unknown workspace, or not a member of it → not_found
//   5. MFA policy requires enrollment   → mfa_enroll
//   6. a historical slug                → redirect to the canonical slugs
//   7. otherwise                        → the viewer
import type { AppSession, SessionUser } from "./session";
import { evaluateMfaGate, mfaGateApplies } from "./mfa-gate";
import type { TenancyLookups } from "./tenancy-lookups";
import { ORG_ONLY_WS, type Scope } from "./tenant-scope";

export type Viewer = {
  userId: string;
  user: SessionUser;
  /** The member's organization role, lowercase (owner, admin, member, billing, …). */
  orgRole: string;
  scope: Scope;
  org: { id: string; slug: string; name: string };
  ws: { id: string; slug: string; name: string } | null;
};

export type ViewerResolution =
  | { kind: "ok"; viewer: Viewer }
  | { kind: "unauthenticated" }
  | { kind: "not_found" }
  | { kind: "mfa_enroll" }
  | { kind: "redirect"; org: string; ws: string | null };

/**
 * The slug format org and workspace create/rename validate against. A value
 * that fails it (favicon.ico, robots.txt falling through to [org]) was never a
 * slug, so it 404s without a database round trip.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(value: string): boolean {
  return value.length <= 128 && SLUG_PATTERN.test(value);
}

export type ResolveViewerDeps = {
  session: AppSession | null;
  lookups: TenancyLookups;
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
  if (!role) return { kind: "not_found" };

  let ws: Viewer["ws"] = null;
  if (wsSlug !== undefined) {
    const found =
      (await lookups.workspaceBySlug(org.id, wsSlug)) ??
      (await lookups.workspaceBySlugHistory(org.id, wsSlug));
    if (!found || found.orgId !== org.id) return { kind: "not_found" };
    if (!(await lookups.isWorkspaceMember(found.id, userId)))
      return { kind: "not_found" };
    ws = { id: found.id, slug: found.slug, name: found.name };
  }

  const policy = await lookups.mfaPolicy(org.id);
  if (mfaGateApplies(role, policy)) {
    const decision = evaluateMfaGate({
      role,
      policy,
      twoFactorEnabled: await lookups.twoFactorEnabled(userId),
      now: deps.now,
    });
    if (decision.action === "enroll") return { kind: "mfa_enroll" };
  }

  if (org.slug !== orgSlug || (ws !== null && ws.slug !== wsSlug)) {
    return { kind: "redirect", org: org.slug, ws: ws?.slug ?? null };
  }

  return {
    kind: "ok",
    viewer: {
      userId,
      user: session.user,
      orgRole: role,
      scope: { orgId: org.id, workspaceId: ws?.id ?? ORG_ONLY_WS },
      org: { id: org.id, slug: org.slug, name: org.name },
      ws,
    },
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
