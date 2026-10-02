// collectors/send-back.ts: send a work order back to its work item (spend
// spec, detector 8, its second lever; F34, #5085).
//
// @oxagen/billing's findWorkOrderSendBacks finds each open send whose last
// runs ended with nothing kept. sendBackWorkOrders posts one send note on each
// send's work item, through runWriteBack, with those runs and their spend
// attached. It starts no run and changes nothing in Oxagen's record of the
// work order. A person reads the note and decides what to do with the work.
//
// A streak is the send and the newest run in it. The record says which
// streaks have a note already, so a later pass that finds the same streak
// posts nothing. A new run on the send starts a new streak. The record is a
// port, and every caller must pass one: without it, each pass would post the
// same note again.
import type { WriteBackTarget } from "./types";
import {
  type WriteBackCollector,
  type WriteBackOutcome,
  type WriteBackSpendRun,
  runWriteBack,
} from "./writeback";

/** A send to go back to its work item. @oxagen/billing's WorkOrderSendBack fits it. */
export interface WorkOrderToSendBack {
  /** `work.orders.id`. */
  orderId: string;
  /** `wo_…`, which the note names. */
  orderPublicId: string;
  /** `work.items.id`. */
  itemId: string;
  /** The agent's key on the streak's newest run; null when it named none. */
  agentKey: string | null;
  /** The runs that ended with nothing kept, newest first. */
  runs: readonly WriteBackSpendRun[];
}

/** One streak: the send and the newest run in it. */
export interface SendBackKey {
  orderId: string;
  lastRunId: string;
}

/** Which streaks already have a note on their work item. */
export interface SendBackRecord {
  has(key: SendBackKey): Promise<boolean>;
  /** Called once the note is written. */
  add(key: SendBackKey): Promise<void>;
}

/** Where a work item's note goes. */
export interface SendBackTarget {
  collector: WriteBackCollector;
  target: WriteBackTarget;
}

export interface SendBackPorts {
  /**
   * The collector a work item came from and the provider item to write on.
   * Null when the work item has no collector, such as one a person entered.
   */
  resolve(itemId: string): Promise<SendBackTarget | null>;
  record: SendBackRecord;
}

/**
 * What happened to one send, beside runWriteBack's outcomes:
 * - already_sent: the record holds this streak, so nothing was written.
 * - no_collector: the work item has no collector to write through.
 */
export type SendBackOutcome = WriteBackOutcome | "already_sent" | "no_collector";

export interface SendBackResult {
  orderId: string;
  outcome: SendBackOutcome;
}

/** The note's text before its spend lines. Oxagen writes all of it. */
export function sendBackNoteText(order: WorkOrderToSendBack): string {
  const count = order.runs.length;
  const ran =
    order.agentKey === null
      ? `The work order ran ${count} times in a row`
      : `Agent ${order.agentKey} ran it ${count} times in a row`;
  return `Oxagen sent work order ${order.orderPublicId} back to this work item. ${ran}, and each run ended with nothing kept. Read why each run ended before you send the work again.`;
}

/**
 * Post one send note per send, each with its runs and their spend, and record
 * each streak whose note was written. A switch that is off, a paused
 * collector, or a module with no write-back writes nothing and records
 * nothing, so a later pass tries again. Each send is tried even when an
 * earlier one fails, and the first failure is thrown once all are tried.
 */
export async function sendBackWorkOrders(
  orders: readonly WorkOrderToSendBack[],
  ports: SendBackPorts,
): Promise<SendBackResult[]> {
  const results: SendBackResult[] = [];
  let failure: { err: unknown } | null = null;
  for (const order of orders) {
    const newest = order.runs[0];
    if (newest === undefined) {
      throw new Error(`Work order ${order.orderPublicId} has no runs to send back.`);
    }
    const key: SendBackKey = { orderId: order.orderId, lastRunId: newest.runId };
    try {
      if (await ports.record.has(key)) {
        results.push({ orderId: order.orderId, outcome: "already_sent" });
        continue;
      }
      const resolved = await ports.resolve(order.itemId);
      if (resolved === null) {
        results.push({ orderId: order.orderId, outcome: "no_collector" });
        continue;
      }
      const outcome = await runWriteBack(resolved.collector, resolved.target, {
        switch: "send_note",
        text: sendBackNoteText(order),
        spend: { runs: order.runs },
      });
      if (outcome === "written") await ports.record.add(key);
      results.push({ orderId: order.orderId, outcome });
    } catch (err) {
      failure ??= { err };
    }
  }
  if (failure !== null) throw failure.err;
  return results;
}
