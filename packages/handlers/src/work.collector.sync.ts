// work.collector.sync.ts: sync_work_collector, a person asks a collector to
// read its repositories now, even while it is failing (P1-03, #5103). A paused
// collector stays paused: resume it with set_work_collector first.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  workCollectorSync,
  type WorkCollectorSyncOutput,
} from "@oxagen/oxagen/contracts/work.collector.sync";
import { assertContractRole } from "./lib/capability-role-guard";
import { type WorkEvent, sendWorkEvents } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

/** How a call names its collector: by row id or by name. */
export type CollectorRef = { id: string } | { name: string };

export interface WorkCollectorSyncDeps {
  find(scope: WorkScope, ref: CollectorRef): Promise<{ id: string; health: string } | null>;
  send(events: readonly WorkEvent[]): Promise<void>;
  now(): Date;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkCollectorSyncDeps: WorkCollectorSyncDeps = {
  async find(scope, ref) {
    const [{ withTenantDb }, { findCollector, findCollectorByName }] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/collectors"),
    ]);
    return withTenantDb((tx) => ("id" in ref ? findCollector(tx, scope, ref.id) : findCollectorByName(tx, scope, ref.name)));
  },
  send: sendWorkEvents,
  now: () => new Date(),
};

export function createWorkCollectorSyncHandler(deps: WorkCollectorSyncDeps): CapabilityHandler<typeof workCollectorSync> {
  return async (input, ctx): Promise<WorkCollectorSyncOutput> => {
    await assertContractRole(workCollectorSync, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    if ((input.collector_id === undefined) === (input.name === undefined)) {
      throw new CapabilityError(
        workCollectorSync.name,
        "invalid_input",
        "Name the collector by collector_id or by name, and not both.",
      );
    }
    const ref: CollectorRef = input.collector_id !== undefined ? { id: input.collector_id } : { name: input.name ?? "" };
    const collector = await deps.find(scope, ref);
    if (collector === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "collector_not_found",
        message: `This workspace has no work collector ${input.collector_id ?? input.name}.`,
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
        id: `work-check-sync-${collector.id}-${deps.now().getTime()}`,
        data: {
          org_id: scope.orgId,
          workspace_id: scope.workspaceId,
          collector_id: collector.id,
          check: "reconcile",
          force: true,
        },
      },
    ]);
    return { collector_id: collector.id, queued: true };
  };
}

export const workCollectorSyncHandler = createWorkCollectorSyncHandler(defaultWorkCollectorSyncDeps);
