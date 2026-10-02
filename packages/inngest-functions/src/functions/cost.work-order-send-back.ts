// cost.work-order-send-back: post each send-back note on a schedule (R3,
// #5108; spend spec, detector 8, its second lever).
//
// Hourly at 45 past, 30 minutes after the outcome refresh writes the hour's
// outcomes, one pass per workspace with a sealed run in the outcome window:
//
//   1. findWorkOrderSendBacks (@oxagen/billing) finds each open send whose
//      last 3 runs each ended with nothing kept (F34, #5085).
//   2. The pass drops a send whose streak shares a run with a note already
//      posted, so a new run starts a fresh count of 3.
//   3. sendBackWorkOrders (@oxagen/ingestion/collectors) posts one note on
//      each send's work item through write-back, with those runs and their
//      spend, and records the streak in work.send_backs once the note is
//      written.
//
// A send gets one note however many passes find the same streak. A switch
// that is off, a paused collector, or a module with no write-back records
// nothing, so the next pass tries again. The ports come from
// `@oxagen/handlers` through lib/work-order-send-back-ports.ts. Nothing here
// starts a run or changes a work order.
import {
  findWorkOrderSendBacks,
  listWorkspacesForOutcomes,
  type WorkOrderSendBack,
} from "@oxagen/billing";
import {
  type SendBackOutcome,
  type SendBackRecord,
  sendBackWorkOrders,
} from "@oxagen/ingestion/collectors";
import { runInTenantScope } from "@oxagen/tenancy";
import { createFunction } from "../create-function";
import {
  type WorkOrderSendBackScope,
  workOrderSendBackPorts,
} from "../lib/work-order-send-back-ports";
import { logger } from "../logger";

/** What one workspace's pass did: the sends it found and how many ended in each outcome. */
interface SendBackPassResult {
  found: number;
  outcomes: Partial<Record<SendBackOutcome, number>>;
}

/**
 * True when a note already named one of the streak's older runs. A note names
 * its streak by the newest run, and a streak is the send's newest runs in a
 * row. So after a note on runs c, b, and a, the next run d makes the streak d,
 * c, b, which still holds c. Dropping that streak means a send goes back again
 * only once 3 new runs in a row end with nothing kept. sendBackWorkOrders
 * checks the newest run itself.
 */
async function overlapsPostedNote(
  order: WorkOrderSendBack,
  record: SendBackRecord,
): Promise<boolean> {
  for (const run of order.runs.slice(1)) {
    if (await record.has({ orderId: order.orderId, lastRunId: run.runId }))
      return true;
  }
  return false;
}

/** Find the workspace's sends to go back, then send each one back. */
async function sendBackPass(
  scope: WorkOrderSendBackScope,
  now: Date,
): Promise<SendBackPassResult> {
  const found = await findWorkOrderSendBacks(scope, now);
  if (found.length === 0) return { found: 0, outcomes: {} };
  const ports = await workOrderSendBackPorts()(scope);
  const outcomes: Partial<Record<SendBackOutcome, number>> = {};
  const count = (outcome: SendBackOutcome): void => {
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
  };
  await runInTenantScope(scope, async () => {
    const fresh: WorkOrderSendBack[] = [];
    for (const order of found) {
      // The streak's runs already went back with an earlier note.
      if (await overlapsPostedNote(order, ports.record)) count("already_sent");
      else fresh.push(order);
    }
    for (const result of await sendBackWorkOrders(fresh, ports))
      count(result.outcome);
  });
  return { found: found.length, outcomes };
}

/**
 * Hourly at 45 past: one send-back pass per workspace with a sealed run in
 * the outcome window. A pass returns counts only, because a durable step's
 * output is JSON and the finder's costs are bigints. One workspace's failed
 * pass does not stop the sweep, and the next hour retries it.
 *
 * One run at a time. A pass checks the record, posts the note, then records
 * it, so two overlapping runs could both post one streak's note. The unique
 * index would stop only the second row.
 */
export const [costWorkOrderSendBackHourly] = createFunction(
  {
    id: "cost.work-order-send-back-hourly",
    retries: 2,
    concurrency: { limit: 1 },
  },
  { cron: "45 * * * *" },
  async ({ step }) => {
    const scopes = await step.run("list-workspaces", () =>
      listWorkspacesForOutcomes(new Date()),
    );
    let passed = 0;
    let found = 0;
    let written = 0;
    for (const scope of scopes) {
      const out = await step.run(
        `send-back-${scope.workspaceId}`,
        async (): Promise<SendBackPassResult | null> => {
          try {
            return await sendBackPass(scope, new Date());
          } catch (err) {
            logger.warn(
              { workspaceId: scope.workspaceId, err },
              "cost.work-order-send-back-hourly: pass failed",
            );
            return null;
          }
        },
      );
      if (out === null) continue;
      passed += 1;
      found += out.found;
      written += out.outcomes.written ?? 0;
    }
    logger.info(
      { workspaces: scopes.length, passed, found, written },
      "cost.work-order-send-back-hourly complete",
    );
    return { workspaces: scopes.length, passed, found, written };
  },
);
