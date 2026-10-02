// viewer.ts: what the person reading the Work pages may do, from the same
// role check each Work action makes (P1-05, #5163).
//
// `can_control` covers entering items, correcting triage, writing briefs,
// sending, stopping, returning, closing, and reopening (work.control).
// `can_approve` covers approving a brief and accepting work (work.approve).
// Each flag asks assertOrgRole for the roles the action takes
// (workActionRoles in @oxagen/work/records), as the acting user.
//
// Every one of those actions refuses an API key and an agent run
// (lib/work-records/actor.ts), so both flags are false for those callers
// without a role read. The flags decide nothing: each action checks again on
// the server.
import type { CapabilityContext } from "@oxagen/oxagen";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { workActionRoles } from "@oxagen/work/records";

/** What the viewer may do on the Work pages. */
export interface WorkViewer {
  can_control: boolean;
  can_approve: boolean;
}

const NOTHING: WorkViewer = { can_control: false, can_approve: false };

/** True when the role check passed, false when it refused the person. Any other error is thrown. */
async function passes(check: Promise<string>): Promise<boolean> {
  try {
    await check;
    return true;
  } catch (error) {
    if (isHandlerError(error) && error.code === "forbidden") return false;
    throw error;
  }
}

/** The viewer flags for the caller of a Work read. */
export async function workViewer(ctx: CapabilityContext): Promise<WorkViewer> {
  if (ctx.apiKeyId || ctx.agentRun) return NOTHING;
  const userId = await resolveActingUserId(ctx);
  if (userId === null) return NOTHING;
  const canControl = await passes(
    assertOrgRole({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId }, workActionRoles("send")),
  );
  const canApprove = await passes(
    assertOrgRole({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId }, workActionRoles("accept")),
  );
  return { can_control: canControl, can_approve: canApprove };
}
