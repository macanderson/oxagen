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
import { resolveViewer, type Viewer } from "@/server/scope";
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
 * The org and workspace a flow runs in, for a viewer `requireViewer` already
 * admitted: signed in, a member of the organization AND of the workspace, MFA
 * satisfied, on the canonical slugs. This read adds only the namespaces agent
 * keys use, looked up by the ids that check resolved, never by slug.
 */
export async function loadViewerFlowScope(
  viewer: Viewer,
): Promise<Read<FlowScope>> {
  const { ws } = viewer;
  if (!ws) return readError(SCOPE_NOT_FOUND, 404);
  const operator = { name: viewer.user.name ?? "", email: viewer.user.email };
  if (isFixtureMode()) {
    return viewer.org.slug === FIXTURE_SCOPE.org.slug &&
      ws.slug === FIXTURE_SCOPE.ws.slug
      ? readOk({ ...FIXTURE_SCOPE, operator })
      : readError(SCOPE_NOT_FOUND, 404);
  }
  const { orgId, workspaceId } = viewer.scope;
  const { withSystemDb } = await import("@oxagen/database");
  // tenancy: unscoped seam (namespace columns only, by the org and workspace ids requireViewer admitted this user to)
  const namespaces = await withSystemDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: (o, { and, eq, ne }) =>
        and(eq(o.id, orgId), ne(o.status, "deleted")),
      columns: { namespace: true },
    });
    if (!org) return null;
    const workspace = await tx.query.workspaces.findFirst({
      where: (w, { and, eq }) => and(eq(w.orgId, orgId), eq(w.id, workspaceId)),
      columns: { namespace: true },
    });
    return workspace ? { org: org.namespace, ws: workspace.namespace } : null;
  });
  if (!namespaces) return readError(SCOPE_NOT_FOUND, 404);
  return readOk({
    org: {
      slug: viewer.org.slug,
      name: viewer.org.name,
      namespace: namespaces.org,
    },
    ws: { slug: ws.slug, name: ws.name, namespace: namespaces.ws },
    operator,
  });
}

/**
 * The gate's wrap and run steps name their scope in the query string, so they
 * resolve it without a navigation interrupt: any result `requireViewer` would
 * refuse (signed out, not a member of the org or the workspace, MFA overdue, a
 * historical slug) reads as not found, and the screen offers step 1 again.
 */
export async function loadFlowScope(
  orgSlug: string,
  wsSlug: string,
): Promise<Read<FlowScope>> {
  const result = await resolveViewer(orgSlug, wsSlug);
  return result.kind === "ok"
    ? loadViewerFlowScope(result.viewer)
    : readError(SCOPE_NOT_FOUND, 404);
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
