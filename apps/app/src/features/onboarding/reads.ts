// Reads for the onboarding gate and Register an agent, each returning Read<T>
// through the onboarding read port (src/data/ports.ts `OnboardingReadPort`).
//
// What is backed today (plan §3.2 "Auth + onboarding gate", 🟡): organizations,
// workspaces, memberships and the namespaces agent keys use. What is not (G15,
// milestone M1): the gate state itself, the one-click installer with its
// embedded single-use token, the first frame arriving from a freshly wrapped
// agent, and the repository the installer saw. The live source answers those
// NotBacked, and the screens say so instead of pretending to wait. In dev and
// e2e the fixture source serves the mockup's gate, and its `mc_state` switch
// walks the loading, error and denied states through these same reads.
import "server-only";
import type {
  DetectedRepository,
  FirstFrameScript,
  FlowScope,
  InstallerOffer,
  OnboardingGate,
} from "@/data/contracts/onboarding";
import { type Read, readError, readOk } from "@/data/not-backed";
import type { OnboardingFlow } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { dataSource } from "@/data/source";
import { resolveViewer, type Viewer } from "@/server/scope";

export const SCOPE_NOT_FOUND = "workspace_not_found";

/** A flow's organization and workspace, with the tenant scope `requireViewer` admitted. */
export type ResolvedFlow = FlowScope & { tenant: Scope };

/**
 * The org and workspace a flow runs in, for a viewer `requireViewer` already
 * admitted: signed in, a member of the organization AND of the workspace, MFA
 * satisfied, on the canonical slugs. This read adds only the namespaces agent
 * keys use, looked up by the ids that check resolved, never by slug.
 */
export async function loadViewerFlowScope(
  viewer: Viewer,
): Promise<Read<ResolvedFlow>> {
  const { ws } = viewer;
  if (!ws) return readError(SCOPE_NOT_FOUND, 404);
  const namespaces = await (await dataSource()).onboarding.namespaces(
    viewer.scope,
  );
  if (!namespaces.ok) return readError(SCOPE_NOT_FOUND, 404);
  return readOk({
    org: {
      slug: viewer.org.slug,
      name: viewer.org.name,
      namespace: namespaces.value.org,
    },
    ws: { slug: ws.slug, name: ws.name, namespace: namespaces.value.ws },
    operator: { name: viewer.user.name ?? "", email: viewer.user.email },
    tenant: viewer.scope,
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
): Promise<Read<ResolvedFlow>> {
  const result = await resolveViewer(orgSlug, wsSlug);
  return result.kind === "ok"
    ? loadViewerFlowScope(result.viewer)
    : readError(SCOPE_NOT_FOUND, 404);
}

/** Where the gate stands. Null scope: the organization does not exist yet. */
export async function loadGate(
  flow: OnboardingFlow,
  scope: Scope | null,
): Promise<Read<OnboardingGate>> {
  return (await dataSource()).onboarding.gate(flow, scope);
}

export async function loadInstallerOffer(
  flow: OnboardingFlow,
  scope: ResolvedFlow,
): Promise<Read<InstallerOffer>> {
  return (await dataSource()).onboarding.installerOffer(scope.tenant, flow);
}

export async function loadFirstFrameScript(
  flow: OnboardingFlow,
  scope: ResolvedFlow,
  agentKey: string,
  harness: string,
): Promise<Read<FirstFrameScript>> {
  return (await dataSource()).onboarding.firstFrameScript(scope.tenant, {
    flow,
    agentKey,
    harness,
    operator: scope.operator.name,
  });
}

export async function loadDetectedRepository(
  scope: ResolvedFlow,
): Promise<Read<DetectedRepository>> {
  return (await dataSource()).onboarding.detectedRepository(scope.tenant);
}
