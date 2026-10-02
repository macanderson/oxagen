// work.outcomes.get.ts: get_work_outcomes, what the workspace's Phase 1 work
// finished in a window of days (P1-05, #5163).
//
// The role check runs first, before any read. Every figure is counted from
// the work records (lib/work-read/outcomes.ts), and none names a person.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { workOutcomesGet, type WorkOutcomesGetOutput } from "@oxagen/oxagen/contracts/work.outcomes.get";
import { assertContractRole } from "./lib/capability-role-guard";
import { refusingAs } from "./lib/work-records/errors";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkOutcomesGetDeps {
  /** The counts for the last `days` days before `now`. */
  read(scope: WorkScope, days: number, now: Date): Promise<WorkOutcomesGetOutput>;
  now(): Date;
}

/** The Postgres reads, loaded on the first call. */
export const defaultWorkOutcomesGetDeps: WorkOutcomesGetDeps = {
  async read(scope, days, now) {
    return (await import("./lib/work-read/read")).readWorkOutcomes(scope, days, now);
  },
  now: () => new Date(),
};

export function createWorkOutcomesGetHandler(deps: WorkOutcomesGetDeps): CapabilityHandler<typeof workOutcomesGet> {
  return async (input, ctx): Promise<WorkOutcomesGetOutput> => {
    await assertContractRole(workOutcomesGet, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    return refusingAs(workOutcomesGet.name, () => deps.read(scope, input.days, deps.now()));
  };
}

export const workOutcomesGetHandler = createWorkOutcomesGetHandler(defaultWorkOutcomesGetDeps);
