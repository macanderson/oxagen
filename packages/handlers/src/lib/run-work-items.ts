// The work item each run served, for the lines that name one (#2962).
//
// The cost rollup stores each run's work order on `cost.run_totals` (F13,
// #4638): a send in `work.orders` or a direct work order in
// `work.direct_orders`. A send always names its work item. A direct work
// order names one only once a person attaches it, so an unattached one
// answers nothing here. A soft-deleted work item keeps its number, and the
// spend it bought still happened, so it is named too.
//
// One query per kind for every work order asked about, in chunks, so a month
// of runs costs two reads and not one per run.
import { and, eq, inArray } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";

export type RunWorkItemScope = { orgId: string; workspaceId: string };

/** A run's work order, as `cost.run_totals` names it. */
export type RunWorkOrderRef = {
  workOrderId: string;
  workOrderKind: "send" | "direct";
};

/** The work item a work order served. */
export type RunWorkItem = {
  /** The work item's public id (`wi_…`). */
  id: string;
  /** The number people say out loud, such as `OPS-88`. */
  number: string;
  subject: string;
};

export type ReadRunWorkItems = (
  scope: RunWorkItemScope,
  orders: readonly RunWorkOrderRef[],
) => Promise<Map<string, RunWorkItem>>;

/** The key {@link ReadRunWorkItems} answers each work order under. */
export function workOrderKey(order: RunWorkOrderRef): string {
  return `${order.workOrderKind}:${order.workOrderId}`;
}

const IN_CHUNK = 1_000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK)
    out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

export const readRunWorkItems: ReadRunWorkItems = async (scope, orders) => {
  const found = new Map<string, RunWorkItem>();
  const sends = [
    ...new Set(
      orders.filter((o) => o.workOrderKind === "send").map((o) => o.workOrderId),
    ),
  ];
  const directs = [
    ...new Set(
      orders
        .filter((o) => o.workOrderKind === "direct")
        .map((o) => o.workOrderId),
    ),
  ];
  if (sends.length === 0 && directs.length === 0) return found;
  const items = schema.workItems;
  const sent = schema.workOrders;
  const direct = schema.workDirectOrders;
  await withTenantDb(async (tx) => {
    for (const part of chunks(sends)) {
      const rows = await tx
        .select({
          orderId: sent.id,
          id: items.publicId,
          number: items.number,
          subject: items.subject,
        })
        .from(sent)
        .innerJoin(
          items,
          and(eq(items.id, sent.itemId), eq(items.orgId, sent.orgId)),
        )
        .where(
          and(
            eq(sent.orgId, scope.orgId),
            eq(sent.workspaceId, scope.workspaceId),
            inArray(sent.id, part),
          ),
        );
      for (const row of rows)
        found.set(
          workOrderKey({ workOrderId: row.orderId, workOrderKind: "send" }),
          { id: row.id, number: row.number, subject: row.subject },
        );
    }
    for (const part of chunks(directs)) {
      // The inner join drops a direct work order no person has attached.
      const rows = await tx
        .select({
          orderId: direct.id,
          id: items.publicId,
          number: items.number,
          subject: items.subject,
        })
        .from(direct)
        .innerJoin(
          items,
          and(eq(items.id, direct.itemId), eq(items.orgId, direct.orgId)),
        )
        .where(
          and(
            eq(direct.orgId, scope.orgId),
            eq(direct.workspaceId, scope.workspaceId),
            inArray(direct.id, part),
          ),
        );
      for (const row of rows)
        found.set(
          workOrderKey({ workOrderId: row.orderId, workOrderKind: "direct" }),
          { id: row.id, number: row.number, subject: row.subject },
        );
    }
  });
  return found;
};

/** For a test or a surface that has no store: no run names a work item. */
export const noRunWorkItems: ReadRunWorkItems = () =>
  Promise.resolve(new Map<string, RunWorkItem>());
