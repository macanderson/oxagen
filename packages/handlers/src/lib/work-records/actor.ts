// actor.ts: who may decide a work item, checked on the server (P1-04).
//
// A work item grants no authority (agent-work-phase-1.html, Delivery and
// review). Every person's action on one is checked here, whatever the page
// showed:
//
//   - The caller is a signed-in person. A decision fact's source is `person`
//     (ADR-244), so it must come from a session, never from an API key: an
//     agent that holds its operator's key could otherwise approve, send, or
//     accept its own work. An agent run is refused for the same reason.
//   - The person holds a role the action takes on the item's own org or
//     workspace (`workActionRoles`). The kernel scope is the item's
//     workspace, so a role in another workspace grants nothing here.
//
// A runtime's calls (claim and reject) are checked by the host credential
// instead: see runtime.ts.
import type { CapabilityContext } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { type WorkItemAction, workActionRoles } from "@oxagen/work/records";

/** The person behind a work decision, after the checks. */
export interface WorkActor {
  userId: string;
  /** The role that satisfied the check, for the record. */
  role: string;
}

/**
 * Refuse unless the caller is a signed-in person who holds a role `action`
 * takes in the call's org or workspace. Returns the person's user id.
 */
export async function assertWorkActor(ctx: CapabilityContext, action: WorkItemAction): Promise<WorkActor> {
  if (ctx.agentRun) {
    throw new HandlerError({
      code: "forbidden",
      reason: "agent_run",
      message: "An agent run cannot decide work. A person decides it in Oxagen.",
    });
  }
  if (!ctx.userId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "person_required",
      message: "Sign in to Oxagen to decide work. An API key cannot approve, send, return, or accept work.",
    });
  }
  // With the API key refused above, the acting user is the session's own
  // (INV-29: every role gate acts as the user resolveActingUserId returns).
  const userId = await resolveActingUserId(ctx);
  if (userId === null) {
    throw new HandlerError({ code: "forbidden", reason: "person_required", message: "Sign in to Oxagen to decide work." });
  }
  const role = await assertOrgRole({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId }, workActionRoles(action));
  return { userId, role };
}
