// work.item.create.ts: create_work_item, a person enters a work item by hand
// (P1-03, #5103). The item records an `entered` fact on revision 1, then
// work/item.received sends it to triage like an item a collector brought in.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workItemCreate,
  type WorkItemCreateOutput,
} from "@oxagen/oxagen/contracts/work.item.create";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { resolveActingUserId } from "@oxagen/iam/org-role";
import { assertContractRole } from "./lib/capability-role-guard";
import type { EnterItemInput, EnteredItem } from "./lib/work-intake/actions";
import { type WorkEvent, sendWorkEvents, workRefusal } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkItemCreateDeps {
  enter(scope: WorkScope, input: EnterItemInput): Promise<EnteredItem>;
  send(events: readonly WorkEvent[]): Promise<void>;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkItemCreateDeps: WorkItemCreateDeps = {
  async enter(scope, input) {
    return (await import("./lib/work-intake/actions")).enterWorkItem(scope, input);
  },
  send: sendWorkEvents,
};

export function createWorkItemCreateHandler(deps: WorkItemCreateDeps): CapabilityHandler<typeof workItemCreate> {
  return async (input, ctx): Promise<WorkItemCreateOutput> => {
    await assertContractRole(workItemCreate, ctx);
    // assertContractRole answers the role that passed, not who acted. The
    // actor is the person the call acts as, which the record stores as a
    // user id.
    const actorUserId = await resolveActingUserId(ctx);
    if (actorUserId === null) {
      throw new HandlerError({
        code: "forbidden",
        reason: "person_required",
        message: "Sign in to Oxagen to enter a work item. The call names no person to record as the actor.",
      });
    }
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    let item: EnteredItem;
    try {
      item = await deps.enter(scope, {
        subject: input.subject,
        description: input.description ?? null,
        labels: input.labels,
        repository: input.repository ?? null,
        actorUserId,
      });
    } catch (error) {
      throw workRefusal(workItemCreate.name, error);
    }
    await deps.send([
      {
        name: "work/item.received",
        id: `work-item-${item.publicId}-new`,
        // The revision the item was entered on, so a triage failure that
        // lands after the item moved on records nothing.
        data: {
          org_id: scope.orgId,
          workspace_id: scope.workspaceId,
          item_id: item.publicId,
          change: "new",
          revision: item.revision,
        },
      },
    ]);
    return {
      item_id: item.publicId,
      number: item.number,
      state: item.state,
      revision: item.revision,
      version: item.version,
    };
  };
}

export const workItemCreateHandler = createWorkItemCreateHandler(defaultWorkItemCreateDeps);
