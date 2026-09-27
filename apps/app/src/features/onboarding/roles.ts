// Who may run the gate's steps. Every write the gate makes (`create_workspace`,
// `create_enrollment_token`, `advance_onboarding`, and the steering host
// connections) admits an org Owner or Admin in its handler (INV-29). Each step
// checks the same role before it reads, so a member without it sees the gate's
// denied state instead of controls that would all be refused.
import type { OrgCtx, WsCtx } from "@/server/viewer";

const ONBOARDING_ROLES = new Set<string>(["owner", "admin"]);

/** True for an org Owner or Admin. */
export function mayOnboard(ctx: OrgCtx): boolean {
  return ONBOARDING_ROLES.has(ctx.orgRole);
}

/** The denied state's "Signed in as" line on an organization step. */
export function signedInToOrg(
  ctx: OrgCtx,
  name: string | null,
  email: string | null,
): string {
  return `${name || email || "—"} · org.${ctx.orgRole} · ${ctx.orgSlug}`;
}

/** The denied state's "Signed in as" line on a workspace step. */
export function signedInToWorkspace(
  ctx: WsCtx,
  name: string | null,
  email: string | null,
): string {
  return `${name || email || "—"} · workspace.${ctx.wsRole} · ${ctx.wsSlug}`;
}
