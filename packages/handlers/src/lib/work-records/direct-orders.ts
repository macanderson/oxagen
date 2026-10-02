// direct-orders.ts: attach a direct work order to a work item (F13, #4638).
//
// The spend rollup opens a direct work order for each run that no send
// covers (packages/billing/src/run-work-order.ts). Its spend is unassigned
// until a person attaches it to a work item. wasted-spend.html (Operator
// productivity, Unassigned spend) counts a direct work order attached within
// 24 hours of its run's start as assigned from that start, and one attached
// later as assigned from the attachment on. So the attachment records its
// time, from the database's clock, and never moves after.
//
// The caller opens the tenant transaction (withTenantDb inside
// runInTenantScope), checks the actor's role, and passes the transaction in,
// as for store.ts. Row security fences every read and write to the caller's
// org and workspace, and every query here also names them. The database's
// guard refuses a second attachment and a work item from another workspace,
// whichever path writes.
import { schema, type Tx } from "@oxagen/database";
import { WorkRecordError } from "@oxagen/work/records";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { WorkScope } from "./store";

const directOrders = schema.workDirectOrders;
const items = schema.workItems;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A direct work order and the work item it is attached to. */
export interface DirectOrderAttachment {
  /** The direct work order's id in work.direct_orders. */
  directOrderId: string;
  /** Its public id (`dwo_…`). */
  publicId: string;
  /** The run it covers. */
  runId: string;
  /** When the run started. */
  openedAt: Date;
  /** The work item's id in work.items. */
  itemId: string;
  attachedAt: Date;
  /** The user id of the person who attached it. */
  attachedBy: string;
  /** True when the direct work order was already attached to this work item, and nothing changed. */
  repeat: boolean;
}

export interface AttachDirectOrderInput {
  /** The direct work order: its id or its public id (`dwo_…`). */
  directOrder: string;
  /** The work item's id in work.items. */
  itemId: string;
  /** The user id of the person attaching it. */
  by: string;
}

/**
 * Attach a direct work order to a work item and record when. Attaching it
 * again to the same work item is a repeat that changes nothing. Refuses a
 * direct work order or a work item this workspace does not hold, a deleted
 * work item, and a direct work order already attached to another work item.
 */
export async function attachDirectOrder(
  tx: Tx,
  scope: WorkScope,
  input: AttachDirectOrderInput,
): Promise<DirectOrderAttachment> {
  if (input.by.trim() === "") {
    throw new WorkRecordError("invalid_input", "Name the person who attaches the direct work order.");
  }
  const named = UUID.test(input.directOrder)
    ? or(eq(directOrders.id, input.directOrder), eq(directOrders.publicId, input.directOrder))
    : eq(directOrders.publicId, input.directOrder);
  const [order] = await tx
    .select({
      id: directOrders.id,
      publicId: directOrders.publicId,
      runId: directOrders.runId,
      openedAt: directOrders.openedAt,
      itemId: directOrders.itemId,
      attachedAt: directOrders.attachedAt,
      attachedBy: directOrders.attachedBy,
    })
    .from(directOrders)
    .where(and(eq(directOrders.orgId, scope.orgId), eq(directOrders.workspaceId, scope.workspaceId), named))
    .for("update");
  if (!order) {
    throw new WorkRecordError("not_found", "This workspace has no such direct work order.");
  }
  if (order.itemId !== null) {
    if (order.itemId !== input.itemId) {
      throw new WorkRecordError(
        "not_allowed",
        "This direct work order is already attached to another work item. An attachment cannot move.",
      );
    }
    return {
      directOrderId: order.id,
      publicId: order.publicId,
      runId: order.runId,
      openedAt: order.openedAt,
      itemId: order.itemId,
      attachedAt: order.attachedAt as Date,
      attachedBy: order.attachedBy as string,
      repeat: true,
    };
  }

  const [item] = UUID.test(input.itemId)
    ? await tx
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            eq(items.id, input.itemId),
            eq(items.orgId, scope.orgId),
            eq(items.workspaceId, scope.workspaceId),
            isNull(items.deletedAt),
          ),
        )
    : [];
  if (!item) throw new WorkRecordError("not_found", "This workspace has no such work item.");

  const [attached] = await tx
    .update(directOrders)
    .set({ itemId: item.id, attachedAt: sql`clock_timestamp()`, attachedBy: input.by })
    .where(
      and(
        eq(directOrders.id, order.id),
        eq(directOrders.orgId, scope.orgId),
        eq(directOrders.workspaceId, scope.workspaceId),
        isNull(directOrders.itemId),
      ),
    )
    .returning({ attachedAt: directOrders.attachedAt });
  if (!attached || attached.attachedAt === null) {
    throw new Error(`work.direct_orders returned no attachment for ${order.id}.`);
  }
  return {
    directOrderId: order.id,
    publicId: order.publicId,
    runId: order.runId,
    openedAt: order.openedAt,
    itemId: item.id,
    attachedAt: attached.attachedAt,
    attachedBy: input.by,
    repeat: false,
  };
}
