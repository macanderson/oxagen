// work.targets.list.ts: list_work_targets, the workspace's agents and whether
// each can take a send now (P1-05, #5163).
//
// The role check runs first, before any read. Each agent is read the way
// send_work_order reads its target, without refusing, for the person reading:
// an agent takes a send only from the person who operates it. The send checks
// all of it again on the server.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { workTargetsList, type WorkTargetsListOutput } from "@oxagen/oxagen/contracts/work.targets.list";
import { assertContractRole } from "./lib/capability-role-guard";
import type { WorkTarget } from "./lib/work-read/read";
import { refusingAs } from "./lib/work-records/errors";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkTargetsListDeps {
  /** The workspace's agents as targets, for the person `userId`. */
  list(scope: WorkScope, userId: string | null, now: Date): Promise<WorkTarget[]>;
  /** The user the call acts as: the signed-in person, or an API key's creator. */
  actingUser(ctx: CapabilityContext): Promise<string | null>;
  now(): Date;
}

/** The Postgres reads, loaded on the first call. */
export const defaultWorkTargetsListDeps: WorkTargetsListDeps = {
  async list(scope, userId, now) {
    return (await import("./lib/work-read/read")).readWorkTargets(scope, userId, now);
  },
  async actingUser(ctx) {
    return (await import("@oxagen/iam/org-role")).resolveActingUserId(ctx);
  },
  now: () => new Date(),
};

export function createWorkTargetsListHandler(deps: WorkTargetsListDeps): CapabilityHandler<typeof workTargetsList> {
  return async (_input, ctx): Promise<WorkTargetsListOutput> => {
    await assertContractRole(workTargetsList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const userId = await deps.actingUser(ctx);
    return refusingAs(workTargetsList.name, async () => ({ agents: await deps.list(scope, userId, deps.now()) }));
  };
}

export const workTargetsListHandler = createWorkTargetsListHandler(defaultWorkTargetsListDeps);
