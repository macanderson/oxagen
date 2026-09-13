// Reads for the onboarding gate and Register an agent, each returning Read<T>.
//
// What is backed today (plan §3.2 "Auth + onboarding gate", 🟡): organizations,
// workspaces and memberships. What is not (G15, milestone M1): the gate state
// itself, the one-click installer with its embedded single-use token, the first
// frame arriving from a freshly wrapped agent, and the repository the installer
// saw. Those return NotBacked outside fixture mode, and the screens say so
// instead of pretending to wait.
import "server-only";
import { cookies } from "next/headers";
import { type Read, notBacked, readError, readOk } from "@/data/not-backed";
import { isFixtureMode } from "@/server/fixture-session";
import type { AuthUser } from "../auth/session";
import {
  FIXTURE_INSTALLER,
  FIXTURE_REPOSITORY,
  FIXTURE_SCOPE,
  fixtureFirstFrameScript,
} from "./fixture";
import type {
  DetectedRepository,
  FirstFrameScript,
  FlowScope,
  InstallerOffer,
} from "./model";

export const SCOPE_NOT_FOUND = "workspace_not_found";

/** The mc_state switch (plan §4.12), honoured only in fixture mode. Promote: lane L1's state switch. */
export type FixturePageState = "loaded" | "loading" | "error" | "denied";
const STATE_COOKIE = "mc_state";

export async function fixturePageState(): Promise<FixturePageState> {
  if (!isFixtureMode()) return "loaded";
  const value = (await cookies()).get(STATE_COOKIE)?.value;
  return value === "loading" || value === "error" || value === "denied"
    ? value
    : "loaded";
}

/**
 * The org and workspace a flow runs in, resolved from slugs against the user's own
 * memberships: a slug the user is not a member of reads as not found, never as a hint.
 */
export async function loadFlowScope(
  user: AuthUser,
  orgSlug: string,
  wsSlug: string,
): Promise<Read<FlowScope>> {
  if (isFixtureMode()) {
    return orgSlug === FIXTURE_SCOPE.org.slug &&
      wsSlug === FIXTURE_SCOPE.ws.slug
      ? readOk(FIXTURE_SCOPE)
      : readError(SCOPE_NOT_FOUND, 404);
  }
  const { withSystemDb } = await import("@oxagen/database");
  // tenancy: unscoped seam (slug → id before a tenant scope exists; gated on the user's memberships)
  const scope = await withSystemDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: (o, { and, eq, ne }) =>
        and(eq(o.slug, orgSlug), ne(o.status, "deleted")),
      columns: { id: true, slug: true, name: true, namespace: true },
    });
    if (!org) return null;
    const membership = await tx.query.orgUsers.findFirst({
      where: (ou, { and, eq }) =>
        and(eq(ou.orgId, org.id), eq(ou.userId, user.id)),
      columns: { orgId: true },
    });
    if (!membership) return null;
    const ws = await tx.query.workspaces.findFirst({
      where: (w, { and, eq }) => and(eq(w.orgId, org.id), eq(w.slug, wsSlug)),
      columns: { slug: true, name: true, namespace: true },
    });
    return ws ? { org, ws } : null;
  });
  if (!scope) return readError(SCOPE_NOT_FOUND, 404);
  return readOk({
    org: {
      slug: scope.org.slug,
      name: scope.org.name,
      namespace: scope.org.namespace,
    },
    ws: {
      slug: scope.ws.slug,
      name: scope.ws.name,
      namespace: scope.ws.namespace,
    },
    operator: { name: user.name, email: user.email },
  });
}

export function loadInstallerOffer(): Read<InstallerOffer> {
  return isFixtureMode() ? readOk(FIXTURE_INSTALLER) : notBacked("M1", "G15");
}

export function loadFirstFrameScript(
  scope: FlowScope,
  key: string,
  harness: string,
): Read<FirstFrameScript> {
  return isFixtureMode()
    ? readOk(fixtureFirstFrameScript(key, harness, scope.operator.name))
    : notBacked("M1", "G15");
}

export function loadDetectedRepository(): Read<DetectedRepository> {
  return isFixtureMode() ? readOk(FIXTURE_REPOSITORY) : notBacked("M1", "G15");
}
