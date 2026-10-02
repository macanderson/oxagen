// `save_work_brief`: a person saves a new revision of a work item's acceptance brief.
//
// The person is checked first (assertWorkActor: signed in, not an agent run,
// holding a role the action takes in this workspace). The action then runs
// in one tenant transaction through the work record store, and a work record
// refusal reaches the caller as a conflict, not found, forbidden, or invalid
// input (lib/work-records/errors.ts). See ADR-250.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workBriefSave } from "@oxagen/oxagen/contracts/work.brief.save";
import { type Tx, withTenantDb } from "@oxagen/database";
import { assertWorkActor } from "./lib/work-records/actor";
import { refusingAs } from "./lib/work-records/errors";
import { saveWorkBrief } from "./lib/work-records/actions";

export interface WorkBriefSaveDeps {
  /** Opens the tenant transaction. Tests pass a fake. */
  db: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export const defaultWorkBriefSaveDeps: WorkBriefSaveDeps = {
  db: (fn) => withTenantDb(fn),
};

export function createWorkBriefSaveHandler(deps: WorkBriefSaveDeps): CapabilityHandler<typeof workBriefSave> {
  return async (input, ctx) => {
    const actor = await assertWorkActor(ctx, "save_brief");
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workBriefSave.name, () => deps.db((tx) => saveWorkBrief(tx, scope, actor, input)));
  };
}

export const workBriefSaveHandler = createWorkBriefSaveHandler(defaultWorkBriefSaveDeps);
