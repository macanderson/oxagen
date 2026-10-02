// work.triage.retry.ts: retry_work_triage, a person queues triage on one work
// item again (P1-03, #5103). The run waits with the workspace's other triage
// runs, at most 60 a minute, and a person's corrections stay in force.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  workTriageRetry,
  type WorkTriageRetryOutput,
} from "@oxagen/oxagen/contracts/work.triage.retry";
import type { WorkItemState } from "@oxagen/work/records";
import { assertContractRole } from "./lib/capability-role-guard";
import { type WorkEvent, itemNotFound, sendWorkEvents } from "./lib/work-intake/handler-support";
import type { WorkScope } from "./lib/work-records/store";

/** The states triage may run in. Matches TRIAGE_STATES_OPEN in lib/work-intake/triage-run.ts. */
const TRIAGE_OPEN: readonly WorkItemState[] = ["new", "held", "triaged", "needs_info", "changed"];

export interface WorkTriageRetryDeps {
  state(scope: WorkScope, itemPublicId: string): Promise<{ state: WorkItemState } | null>;
  send(events: readonly WorkEvent[]): Promise<void>;
  now(): Date;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkTriageRetryDeps: WorkTriageRetryDeps = {
  async state(scope, itemPublicId) {
    return (await import("./lib/work-intake/actions")).itemState(scope, itemPublicId);
  },
  send: sendWorkEvents,
  now: () => new Date(),
};

export function createWorkTriageRetryHandler(deps: WorkTriageRetryDeps): CapabilityHandler<typeof workTriageRetry> {
  return async (input, ctx): Promise<WorkTriageRetryOutput> => {
    await assertContractRole(workTriageRetry, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const found = await deps.state(scope, input.item_id);
    if (found === null) throw itemNotFound(input.item_id);
    if (!TRIAGE_OPEN.includes(found.state)) {
      throw new HandlerError({
        code: "conflict",
        reason: "not_allowed",
        message: `The work item is ${found.state}. Triage runs only while an item is new, held, triaged, needs_info, or changed.`,
      });
    }
    await deps.send([
      {
        name: "work/item.received",
        // A fresh id each time, so a second retry is not dropped as a repeat.
        id: `work-item-${input.item_id}-retry-${deps.now().getTime()}`,
        data: { org_id: scope.orgId, workspace_id: scope.workspaceId, item_id: input.item_id, change: "retry" },
      },
    ]);
    return { item_id: input.item_id, state: found.state, queued: true };
  };
}

export const workTriageRetryHandler = createWorkTriageRetryHandler(defaultWorkTriageRetryDeps);
