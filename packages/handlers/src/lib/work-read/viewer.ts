// viewer.ts: what the person reading the Work pages may do, from the same
// role check each Work action makes (P1-05, #5163).
//
// `can_control` covers entering items, correcting triage, writing briefs,
// sending, stopping, returning, closing, and reopening (work.control).
// `can_approve` covers approving a brief and accepting work (work.approve).
// Each flag asks assertOrgRole for the roles the action takes
// (workActionRoles in @oxagen/work/records), as the acting user.
// `can_change_collectors` on list_work_collectors asks for the roles
// set_work_collector's contract grants, as that handler does.
//
// The Work pages are read by a signed-in person. A read made with an API key
// or from an agent run answers every flag false without a role read: the
// work order actions refuse those callers (lib/work-records/actor.ts), and so
// do a change to triage's outcome (work.triage.revise.ts) and a collector
// change (work.collector.set.ts, #5181). Entering an item and a triage field
// correction accept an API key's creator, but the page never acts that way.
// The flags decide nothing: each action checks again on the server.
import type { CheckedContext } from "@oxagen/oxagen";
import type { WorkCollectorsViewerOutput } from "@oxagen/oxagen/contracts/work.collectors.list";
import { workCollectorSet } from "@oxagen/oxagen/contracts/work.collector.set";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { workActionRoles } from "@oxagen/work/records";
import { contractRoleRequirement } from "../capability-role-guard";

/** What the viewer may do on the Work pages. */
export interface WorkViewer {
  can_control: boolean;
  can_approve: boolean;
}

/** What the viewer may do with the workspace's collectors. */
export type WorkCollectorViewer = WorkCollectorsViewerOutput;

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
export async function workViewer(ctx: CheckedContext): Promise<WorkViewer> {
  if (ctx.apiKeyId || ctx.agentRun) return NOTHING;
  const userId = await resolveActingUserId(ctx);
  if (userId === null) return NOTHING;
  // The invoked capability lets the gate admit the workspace's Owner or Admin
  // (#5228), as each Work action's own check does.
  const canControl = await passes(
    assertOrgRole(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId, invokedCapability: ctx.invokedCapability },
      workActionRoles("send"),
    ),
  );
  const canApprove = await passes(
    assertOrgRole(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId, invokedCapability: ctx.invokedCapability },
      workActionRoles("accept"),
    ),
  );
  return { can_control: canControl, can_approve: canApprove };
}

/**
 * Whether the caller of list_work_collectors may change a collector. It asks
 * for the roles set_work_collector's contract grants, a workspace Owner or an
 * org Owner or Admin, and the gate adds a workspace Admin (#5228). A
 * workspace Member reads false (#5181).
 */
export async function collectorViewer(ctx: CheckedContext): Promise<WorkCollectorViewer> {
  if (ctx.apiKeyId || ctx.agentRun) return { can_change_collectors: false };
  const userId = await resolveActingUserId(ctx);
  if (userId === null) return { can_change_collectors: false };
  const canChange = await passes(
    assertOrgRole(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId, invokedCapability: ctx.invokedCapability },
      contractRoleRequirement(workCollectorSet),
    ),
  );
  return { can_change_collectors: canChange };
}
