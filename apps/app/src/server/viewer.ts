// The viewer seam (ARCHITECTURE.md §3.1): who is asking, in what tenant.
//
// A context is an instance of one of four classes, and only this module can
// make one. Each class carries an ES private field that only its constructor
// installs, so the compiler refuses an object literal, a spread, a cross-class
// assignment, `new` and a forged subclass, and `is` refuses at runtime every
// value the constructor did not brand (an `Object.assign({}, ctx, …)` copy, a
// `structuredClone`, a plain object). `mint` freezes the instance; every field
// is `declare`d so no class-field definition runs on it after `super()`.
//
// requireViewer is the session and membership check every [org] layout, page
// and server action runs. The proxy only checks that a session cookie exists;
// this is the real gate.
//
//   no session              → redirect to /login
//   unknown org / workspace → notFound()
//   non-member              → notFound(), indistinguishable from an unknown slug
//   historical slug         → 308 to the canonical URL, rest of the path kept
//   SSO required, session
//   not the org's SSO       → redirect to /login?sso=required, carrying the page
//   MFA enrollment overdue  → redirect to MFA_ENROLL_PATH
//
// A member who lacks a permission is not an exception here: the kernel refuses
// the read or write and the page renders `denied`.
//
// readInvitation and readFreePlanAllowance are the reads here that need no
// session: /invite/[token] renders for a signed-out visitor, and the token is
// the capability (#3049); /signup states the Free plan's published allowance.
import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";
import { permanentRedirectTo, redirectTo } from "@/shared/navigation";
import { routes, type SafePath, sanitizeNext } from "@/shared/safe-path";
import { MFA_ENROLL_PATH } from "./mfa-gate";
import { getSession } from "./session";
import { ssoSignInPath } from "./sso-gate";
import { type InvitationRecord, systemLookups } from "./tenancy-lookups";
import {
  canonicalPath,
  resolveViewerWith,
  type ViewerResolution,
} from "./viewer-resolution";
import { MINT } from "./viewer-mint";

export type { InvitationRecord } from "./tenancy-lookups";
// The zone helper features need for date-bound writes. Features may import
// `@/server/viewer` (ARCHITECTURE.md §2); they may not reach `viewer-zone`
// directly. Re-export keeps one seam and avoids a layer violation.
//
// `ViewerZone` (the return type) is not re-exported: nothing outside
// viewer-zone.ts names it, every caller lets `await viewerTimeZone(...)`
// infer it, and knip flags an export nothing imports.
export { viewerTimeZone } from "./viewer-zone";

/** The stored set: packages/database/src/schema/org.ts:96 and :170 CHECK lower(role) IN (…). */
export type OrgRole =
  | "owner"
  | "admin"
  | "member"
  | "billing"
  | "compliance"
  | "viewer";

export type OrgFields = {
  readonly userId: string;
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgName: string;
  readonly orgRole: OrgRole;
};

/**
 * A workspace membership's role. `workspace.workspace_users.role` carries the
 * same six-value CHECK as `org_users.role`
 * (packages/database/src/schema/workspace.ts:148), so the union is the same
 * one; the separate name says which membership a value came from.
 */
export type WsRole = OrgRole;

export type WsFields = OrgFields & {
  readonly workspaceId: string;
  readonly wsSlug: string;
  readonly wsName: string;
  /**
   * The viewer's role in THIS workspace, lowercased. Several capabilities grant
   * a workspace role beside the org one — `import_tools` admits an org Owner or
   * Admin *or* the workspace's Owner — and without this field a page can only
   * check `orgRole` and so gates narrower than the kernel it guards (#3143).
   * The column is written in both casings; `systemLookups.workspaceMember` is
   * the single point that settles it, so read this field as it comes.
   */
  readonly wsRole: WsRole;
};

export type PretenantFields = { readonly userId: string };

export type InviteeFields = {
  readonly userId: string;
  readonly orgId: string;
  readonly invitationId: string;
};

function refuseForgedToken(token: symbol): void {
  if (token !== MINT) throw new Error("invalid_ctx");
}

/** A member of an organization, on an organization-level page. */
export class OrgCtx {
  #brand!: true;
  declare readonly userId: string;
  declare readonly orgId: string;
  declare readonly orgSlug: string;
  declare readonly orgName: string;
  declare readonly orgRole: OrgRole;

  protected constructor(token: typeof MINT, f: OrgFields) {
    refuseForgedToken(token);
    this.#brand = true;
    Object.assign(this, f);
  }

  static mint(token: typeof MINT, f: OrgFields): OrgCtx {
    const c = new OrgCtx(token, f);
    Object.freeze(c);
    return c;
  }

  static is(x: unknown): x is OrgCtx {
    return typeof x === "object" && x !== null && #brand in x;
  }
}

/** A member of an organization and of one of its workspaces. */
export class WsCtx extends OrgCtx {
  #wsBrand!: true;
  declare readonly workspaceId: string;
  declare readonly wsSlug: string;
  declare readonly wsName: string;
  declare readonly wsRole: WsRole;

  private constructor(token: typeof MINT, f: WsFields) {
    super(token, f);
    this.#wsBrand = true;
  }

  static override mint(token: typeof MINT, f: WsFields): WsCtx {
    const c = new WsCtx(token, f);
    Object.freeze(c);
    return c;
  }

  static override is(x: unknown): x is WsCtx {
    return typeof x === "object" && x !== null && #wsBrand in x;
  }
}

/** A signed-in person before any organization: organization creation, the CLI consent picker. */
export class PretenantCtx {
  #brand!: true;
  declare readonly userId: string;

  private constructor(token: typeof MINT, f: PretenantFields) {
    refuseForgedToken(token);
    this.#brand = true;
    Object.assign(this, f);
  }

  static mint(token: typeof MINT, f: PretenantFields): PretenantCtx {
    const c = new PretenantCtx(token, f);
    Object.freeze(c);
    return c;
  }

  static is(x: unknown): x is PretenantCtx {
    return typeof x === "object" && x !== null && #brand in x;
  }
}

/** A signed-in person holding an invitation. Not a member: no orgRole, no read access. */
export class InviteeCtx {
  #brand!: true;
  declare readonly userId: string;
  declare readonly orgId: string;
  declare readonly invitationId: string;

  private constructor(token: typeof MINT, f: InviteeFields) {
    refuseForgedToken(token);
    this.#brand = true;
    Object.assign(this, f);
  }

  static mint(token: typeof MINT, f: InviteeFields): InviteeCtx {
    const c = new InviteeCtx(token, f);
    Object.freeze(c);
    return c;
  }

  static is(x: unknown): x is InviteeCtx {
    return typeof x === "object" && x !== null && #brand in x;
  }
}

/**
 * The request's path and query, when the platform exposes it. `x-url` is set by
 * the proxy when present; `next-url` is Next's header on client navigations.
 * Null when neither is present: the redirect then lands on the canonical root.
 */
async function requestUrl(): Promise<{
  pathname: string;
  search: string;
} | null> {
  const h = await headers();
  const raw = h.get("x-url") ?? h.get("next-url");
  if (!raw) return null;
  try {
    const url = new URL(raw, "http://internal.invalid");
    return { pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

/** The session's resolution of an organization and, when named, a workspace. */
async function resolveSession(
  orgSlug: string,
  wsSlug?: string,
): Promise<ViewerResolution> {
  const session = await getSession();
  // The MFA deadline is judged against the request's clock. Under partial
  // prefetching a runtime prerender resolves cookies but not the clock, so
  // `new Date()` straight after the session read is a blocking-prerender
  // error; connection() defers it to the request.
  await connection();
  return resolveViewerWith(
    { session, lookups: systemLookups, now: new Date() },
    orgSlug,
    wsSlug,
  );
}

function mintResolved(
  result: Extract<ViewerResolution, { kind: "ok" }>,
): OrgCtx {
  return result.ws === null
    ? OrgCtx.mint(MINT, result.org)
    : WsCtx.mint(MINT, { ...result.org, ...result.ws });
}

const requireCtx = cache(
  async (orgSlug: string, wsSlug?: string): Promise<OrgCtx> => {
    const result = await resolveSession(orgSlug, wsSlug);
    switch (result.kind) {
      case "ok":
        return mintResolved(result);
      case "unauthenticated":
        return redirectTo(routes.login());
      case "not_found":
        return notFound();
      case "mfa_enroll":
        return redirectTo(MFA_ENROLL_PATH);
      case "sso_required": {
        // Back to the page asked for once the identity provider signs them in.
        const url = await requestUrl();
        const next = url
          ? sanitizeNext(`${url.pathname}${url.search}`, routes.root())
          : undefined;
        return redirectTo(ssoSignInPath(next));
      }
      case "redirect": {
        const url = await requestUrl();
        const canonical = canonicalPath({
          pathname: url?.pathname ?? "",
          search: url?.search ?? "",
          base: "/",
          from: { org: orgSlug, ws: wsSlug ?? null },
          to: { org: result.org, ws: result.ws },
        });
        return permanentRedirectTo(sanitizeNext(canonical, routes.root()));
      }
    }
  },
);

export function requireViewer(org: string): Promise<OrgCtx>;
export function requireViewer(org: string, ws: string): Promise<WsCtx>;
export function requireViewer(org: string, ws?: string): Promise<OrgCtx> {
  return requireCtx(org, ws);
}

/** What a route handler learns about its viewer: a minted ctx, or why there is none. */
export type RouteViewer =
  | { kind: "ok"; ctx: OrgCtx }
  | Exclude<ViewerResolution, { kind: "ok" }>;

/**
 * The organization viewer for a route handler (ARCHITECTURE.md §3.1): the
 * resolution requireViewer makes, answered as a value, never as a redirect or
 * a not-found interrupt, so the handler writes its own response.
 */
export async function resolveViewer(org: string): Promise<RouteViewer> {
  const result = await resolveSession(org);
  return result.kind === "ok"
    ? { kind: "ok", ctx: mintResolved(result) }
    : result;
}

/** Signed in, no organization yet; a signed-out request goes to /login, and on to `next` once signed in. */
export const requireUser = cache(
  async (next?: SafePath): Promise<PretenantCtx> => {
    const session = await getSession();
    if (!session) return redirectTo(routes.login(next));
    return PretenantCtx.mint(MINT, { userId: session.user.id });
  },
);

/** `invitations.public_id` as the invitation email carries it; anything else is not a token. */
const INVITATION_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The invitation behind a public token, for /invite/[token]. No session is read
 * and nothing is minted: the token is the capability (§3.7), and the page shows
 * only what the invitation email already disclosed. A malformed token is null
 * before any lookup; an unknown token, or one whose organization is gone, is
 * null. The record comes back whatever its status and expiry, because the page
 * decides what a closed or expired invitation shows
 * (`features/auth/invitation.ts`).
 */
export async function readInvitation(
  token: string,
): Promise<InvitationRecord | null> {
  if (!INVITATION_TOKEN.test(token)) return null;
  return systemLookups.invitationByToken(token);
}

/**
 * The governed actions the Free plan includes each month, for the sign-up
 * page's allowance tag, or null when the plan row is not seeded. No session is
 * read: the published terms belong to no tenant.
 */
export function readFreePlanAllowance(): Promise<number | null> {
  return systemLookups.freePlanIncludedGau();
}

/**
 * The signed-in person an invitation is addressed to, for the accept and
 * decline actions. Signed out → /login; an unknown token, or an invitation
 * addressed to another email → notFound(). Whether the invitation is still
 * open is the handler's decision.
 */
export const requireInvitee = cache(
  async (
    token: string,
  ): Promise<{ ctx: InviteeCtx; invitation: InvitationRecord }> => {
    const session = await getSession();
    if (!session) return redirectTo(routes.login());
    const invitation = await readInvitation(token);
    if (
      !invitation ||
      invitation.email.trim().toLowerCase() !==
        session.user.email.trim().toLowerCase()
    ) {
      return notFound();
    }
    const ctx = InviteeCtx.mint(MINT, {
      userId: session.user.id,
      orgId: invitation.orgId,
      invitationId: invitation.invitationId,
    });
    return { ctx, invitation };
  },
);
