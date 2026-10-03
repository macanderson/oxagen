// work.triage.retry.ts: retry_work_triage, a person queues triage on one work
// item again (P1-03, #5103). The run waits with the workspace's other triage
// runs, at most 60 a minute, and a person's corrections stay in force.
//
// Triage runs once per item revision unless a person asks for a retry, and
// each retry is a model call the organization pays for (ADR-250, amended
// 2026-10-03). So this handler refuses an agent run and every API key before
// it reads anything. That includes an `oxagen login` key that resolves to a
// person, because an agent on its operator's machine can read that key.
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
  /**
   * The item's state, version, and revision. Null when the workspace has no
   * such live item. The event names the revision only when this returns one.
   */
  state(scope: WorkScope, itemPublicId: string): Promise<{ state: WorkItemState; version: number; revision?: number } | null>;
  send(events: readonly WorkEvent[]): Promise<void>;
}

/** The Postgres store and the event client, loaded on the first call. */
export const defaultWorkTriageRetryDeps: WorkTriageRetryDeps = {
  async state(scope, itemPublicId) {
    const [{ withTenantDb }, { findItem }, { readWorkItem }] = await Promise.all([
      import("@oxagen/database"),
      import("./lib/work-intake/actions"),
      import("./lib/work-records/store"),
    ]);
    return withTenantDb(async (tx) => {
      const item = await findItem(tx, scope, itemPublicId);
      if (item === null) return null;
      const record = await readWorkItem(tx, scope, item.id);
      return { state: record.projection.state, version: record.version, revision: record.projection.revision };
    });
  },
  send: sendWorkEvents,
};

export function createWorkTriageRetryHandler(deps: WorkTriageRetryDeps): CapabilityHandler<typeof workTriageRetry> {
  return async (input, ctx): Promise<WorkTriageRetryOutput> => {
    // Who is calling comes first: an agent run, then any API key.
    if (ctx.agentRun) {
      throw new HandlerError({
        code: "forbidden",
        reason: "agent_run",
        message: "An agent run cannot retry triage. A person asks for a retry in Oxagen.",
      });
    }
    if (ctx.apiKeyId || !ctx.userId) {
      throw new HandlerError({
        code: "forbidden",
        reason: "person_required",
        message: "Sign in to Oxagen to retry triage. An API key cannot retry triage, because each retry is a model call.",
      });
    }
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
        // The id names the item and the version the person retried. A
        // repeated request, such as a double click or a client retry, sends
        // the same id, and Inngest drops it. Every triage run that stores a
        // result or a failure moves the version, so a retry after that run
        // sends a new id. The revision stays out of the id: the version
        // already moves with it.
        id: `work-item-${input.item_id}-retry-v${found.version}`,
        data: {
          org_id: scope.orgId,
          workspace_id: scope.workspaceId,
          item_id: input.item_id,
          change: "retry",
          // The revision the person retried, so a failure that lands after
          // the item moved on records nothing.
          ...(found.revision === undefined ? {} : { revision: found.revision }),
        },
      },
    ]);
    return { item_id: input.item_id, state: found.state, queued: true };
  };
}

export const workTriageRetryHandler = createWorkTriageRetryHandler(defaultWorkTriageRetryDeps);
