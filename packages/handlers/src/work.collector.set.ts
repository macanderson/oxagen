// work.collector.set.ts: set_work_collector, create or change a GitHub work
// collector, or pause and resume one (P1-03, #5103). A new, resumed, or
// widened collector reads its repositories at once.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  workCollectorSet,
  type WorkCollectorSetOutput,
} from "@oxagen/oxagen/contracts/work.collector.set";
import { assertContractRole } from "./lib/capability-role-guard";
import type { CollectorView, SetCollectorInput, SetCollectorResult } from "./lib/work-intake/collectors";
import { type WorkEvent, sendWorkEvents, workRefusal } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkCollectorSetDeps {
  /** Write the collector and read it back in one transaction. */
  set(scope: WorkScope, input: SetCollectorInput): Promise<{ result: SetCollectorResult; view: CollectorView }>;
  send(events: readonly WorkEvent[]): Promise<void>;
  now(): Date;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkCollectorSetDeps: WorkCollectorSetDeps = {
  async set(scope, input) {
    const [{ withTenantDb }, collectors] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/collectors"),
    ]);
    return withTenantDb(async (tx) => {
      const result = await collectors.setCollector(tx, scope, input);
      const view = (await collectors.listCollectorViews(tx, scope)).find((entry) => entry.collector_id === result.collectorId);
      if (!view) throw new Error(`The collector ${input.name} was written and then not found.`);
      return { result, view };
    });
  },
  send: sendWorkEvents,
  now: () => new Date(),
};

export function createWorkCollectorSetHandler(deps: WorkCollectorSetDeps): CapabilityHandler<typeof workCollectorSet> {
  return async (input, ctx): Promise<WorkCollectorSetOutput> => {
    const actorUserId = await assertContractRole(workCollectorSet, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    let written: { result: SetCollectorResult; view: CollectorView };
    try {
      written = await deps.set(scope, {
        name: input.name,
        ...(input.connection_id !== undefined ? { connectionId: input.connection_id } : {}),
        ...(input.repos !== undefined ? { repos: input.repos } : {}),
        ...(input.paused !== undefined ? { paused: input.paused } : {}),
        actorUserId,
      });
    } catch (error) {
      throw workRefusal(workCollectorSet.name, error);
    }
    if (written.result.reconcile) {
      await deps.send([
        {
          name: "work/collector.check.requested",
          id: `work-check-set-${written.result.collectorId}-${deps.now().getTime()}`,
          data: {
            org_id: scope.orgId,
            workspace_id: scope.workspaceId,
            collector_id: written.result.collectorId,
            check: "reconcile",
            force: true,
          },
        },
      ]);
    }
    return { collector: written.view, created: written.result.created, reconcile_queued: written.result.reconcile };
  };
}

export const workCollectorSetHandler = createWorkCollectorSetHandler(defaultWorkCollectorSetDeps);
