// work.priorities.get.ts: get_work_priorities, the priorities record triage
// ranks work by, and triage's last 30 days (P1-03, #5103).
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workPrioritiesGet,
  type WorkPrioritiesGetOutput,
} from "@oxagen/oxagen/contracts/work.priorities.get";
import { assertContractRole } from "./lib/capability-role-guard";
import type { PrioritiesSummary } from "./lib/work-intake/actions";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkPrioritiesGetDeps {
  summary(scope: WorkScope): Promise<PrioritiesSummary>;
}

/** The Postgres store, loaded on the first call. */
export const defaultWorkPrioritiesGetDeps: WorkPrioritiesGetDeps = {
  async summary(scope) {
    return (await import("./lib/work-intake/actions")).prioritiesSummary(scope);
  },
};

export function createWorkPrioritiesGetHandler(deps: WorkPrioritiesGetDeps): CapabilityHandler<typeof workPrioritiesGet> {
  return async (_input, ctx): Promise<WorkPrioritiesGetOutput> => {
    await assertContractRole(workPrioritiesGet, ctx);
    const summary = await deps.summary({ orgId: ctx.orgId, workspaceId: ctx.workspaceId });
    return {
      record:
        summary.record === null
          ? null
          : {
              lineage: summary.record.lineage,
              record_id: summary.record.recordId,
              version: summary.record.version,
              hash: summary.record.hash,
              rules: summary.record.rules,
              published_at: summary.record.publishedAt,
            },
      problem: summary.problem,
      last_30_days: summary.last30Days,
    };
  };
}

export const workPrioritiesGetHandler = createWorkPrioritiesGetHandler(defaultWorkPrioritiesGetDeps);
