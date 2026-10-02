// work.collector.sync.ts: sync_work_collector, a person asks a collector to
// read its repositories now, even while it is failing (P1-03, #5103). A paused
// collector stays paused: resume it with set_work_collector first.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  workCollectorSync,
  type WorkCollectorSyncOutput,
} from "@oxagen/oxagen/contracts/work.collector.sync";
import { assertContractRole } from "./lib/capability-role-guard";
import { type WorkEvent, sendWorkEvents } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

export interface WorkCollectorSyncDeps {
  find(scope: WorkScope, collectorId: string): Promise<{ health: string } | null>;
  send(events: readonly WorkEvent[]): Promise<void>;
  now(): Date;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkCollectorSyncDeps: WorkCollectorSyncDeps = {
  async find(scope, collectorId) {
    const [{ withTenantDb }, { findCollector }] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/collectors"),
    ]);
    return withTenantDb((tx) => findCollector(tx, scope, collectorId));
  },
  send: sendWorkEvents,
  now: () => new Date(),
};

export function createWorkCollectorSyncHandler(deps: WorkCollectorSyncDeps): CapabilityHandler<typeof workCollectorSync> {
  return async (input, ctx): Promise<WorkCollectorSyncOutput> => {
    await assertContractRole(workCollectorSync, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const collector = await deps.find(scope, input.collector_id);
    if (collector === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "collector_not_found",
        message: `This workspace has no work collector ${input.collector_id}.`,
      });
    }
    if (collector.health === "paused") {
      throw new HandlerError({
        code: "conflict",
        reason: "collector_paused",
        message: "The collector is paused. Resume it with set_work_collector, which also reads it at once.",
      });
    }
    await deps.send([
      {
        name: "work/collector.check.requested",
        id: `work-check-sync-${input.collector_id}-${deps.now().getTime()}`,
        data: {
          org_id: scope.orgId,
          workspace_id: scope.workspaceId,
          collector_id: input.collector_id,
          check: "reconcile",
          force: true,
        },
      },
    ]);
    return { collector_id: input.collector_id, queued: true };
  };
}

export const workCollectorSyncHandler = createWorkCollectorSyncHandler(defaultWorkCollectorSyncDeps);
