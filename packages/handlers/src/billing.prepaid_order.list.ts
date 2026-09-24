// billing.prepaid_order.list.ts: handler for the list_prepaid_orders
// capability.
//
// audit-exempt: read-only. Lists the organization's own prepaid orders; no
// state changes, nothing privileged is disclosed, and the kernel's
// capability.invoke_* audit records the access.
//
// The list is `billing.prepaid_orders`, LEFT JOINed to the webhook mirror
// `billing.invoices` on stripe_invoice_id for the invoice's number, status,
// due date and hosted pages. `billing.invoices.stripe_invoice_id` is unique
// (invoices_stripe_inv_idx) and an order records at most one invoice, so the
// join adds columns, never a row. An order still in `draft` has sent nothing
// and is not listed. Newest first by the order's created_at, keyset-paged on
// an opaque cursor.
//
// The lines are rebuilt from the order's stored figures by the same function
// that wrote them onto the invoice (prepaidOrderLines), so the list and the
// invoice cannot print different words for one order.
//
// The kernel enters the tenant scope before this handler runs, so the read
// goes through withTenantDb, whose RLS (org_only) is the tenant filter. The
// query ALSO names org_id: a local stack runs with the RLS bypass on, and
// another organization's order must still stay out of the list.
//
// Flow:
//   1. Role gate: assertOrgRole, org Owner, Admin or Billing, for the
//      signed-in user or the creator of the API key. The kernel's IAM check
//      allows every capability for a non-enterprise org, so the handler owns
//      this check (INV-29).
//   2. Decode the cursor; a cursor this handler did not write is
//      invalid_input.
//   3. Read one row past the page, map, and encode the next cursor.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingPrepaidOrderList,
  prepaidOrderStatusSchema,
  type BillingPrepaidOrderListOutput,
  type PrepaidOrderItem,
  type PrepaidOrderLine,
} from "@oxagen/oxagen/contracts/billing.prepaid_order.list";
import {
  prepaidOrderLines,
  type PrepaidOrderLine as BillingPrepaidOrderLine,
  type PrepaidOrderRow,
} from "@oxagen/billing";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, desc, eq, lt, ne, or, type SQL, sql } from "drizzle-orm";

// ---- Cursor -------------------------------------------------------------------------

/** Where a page ended: the last row's creation instant and id. */
type OrderCursor = { at: string; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeCursor(cursor: OrderCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

/** Null for anything that is not a cursor this handler wrote. */
function decodeCursor(raw: string): OrderCursor | null {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      Number.isNaN(Date.parse(value[0])) ||
      !UUID_RE.test(value[1])
    )
      return null;
    return { at: value[0], id: value[1] };
  } catch {
    // Not base64url JSON: a hand-edited or foreign cursor.
    return null;
  }
}

// ---- Query ----------------------------------------------------------------------------

const orders = schema.prepaidOrders;
const invoices = schema.invoices;

/** Millisecond precision, so a cursor built from a JS Date compares exactly. */
const createdAtMs = sql`date_trunc('milliseconds', ${orders.createdAt})`;

function beforeCursor(cursor: OrderCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const instant = new Date(cursor.at);
  return or(
    lt(createdAtMs, instant),
    and(eq(createdAtMs, instant), lt(orders.id, cursor.id)),
  );
}

export type OrderPageQuery = { cursor: OrderCursor | null; limit: number };

/**
 * The organization's sent orders, newest first, with the mirrored invoice
 * beside each (null columns until the webhook has mirrored it). Reads one row
 * past the page so the caller knows whether a next page exists.
 */
export function prepaidOrderPageQuery(
  db: Pick<Tx, "select">,
  orgId: string,
  q: OrderPageQuery,
) {
  return db
    .select({
      order: orders,
      invoiceNumber: invoices.number,
      invoiceStatus: invoices.status,
      invoiceDueAt: invoices.dueAt,
      hostedInvoiceUrl: invoices.hostedInvoiceUrl,
      invoicePdfUrl: invoices.invoicePdfUrl,
    })
    .from(orders)
    .leftJoin(
      invoices,
      and(
        eq(invoices.stripeInvoiceId, orders.stripeInvoiceId),
        eq(invoices.orgId, orders.orgId),
      ),
    )
    .where(
      and(
        eq(orders.orgId, orgId),
        ne(orders.status, "draft"),
        beforeCursor(q.cursor),
      ),
    )
    .orderBy(desc(createdAtMs), desc(orders.id))
    .limit(q.limit + 1);
}

/** One row of the page query. */
export type PrepaidOrderPageRow = {
  order: PrepaidOrderRow;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceDueAt: Date | null;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
};

// ---- Mapping --------------------------------------------------------------------------

const iso = (d: Date | null): string | null =>
  d === null ? null : d.toISOString();

/** A billing line as the wire's line: micro-units, RFC 3339 period. */
export function toPrepaidOrderLine(
  line: BillingPrepaidOrderLine,
): PrepaidOrderLine {
  return {
    kind: line.key,
    description: line.description,
    quantity: line.quantity,
    amountMicros: (BigInt(line.amountCents) * 10_000n).toString(),
    periodStart: iso(line.period?.start ?? null),
    periodEnd: iso(line.period?.end ?? null),
  };
}

function toItem(row: PrepaidOrderPageRow): PrepaidOrderItem {
  const { order } = row;
  const status = prepaidOrderStatusSchema
    .exclude(["draft"])
    .safeParse(order.status);
  // The query excludes drafts and the column's CHECK names the rest: any other
  // word is a broken row, and the read fails rather than guesses.
  if (!status.success)
    throw new RangeError(
      `prepaid order status outside the CHECK: ${order.status}`,
    );
  const lines = prepaidOrderLines(order).map(toPrepaidOrderLine);
  const invoiceStatus =
    row.invoiceStatus === null
      ? null
      : prepaidOrderStatusSchema.safeParse(row.invoiceStatus);
  if (invoiceStatus !== null && !invoiceStatus.success) {
    throw new RangeError(
      `invoice status outside the CHECK: ${row.invoiceStatus}`,
    );
  }
  return {
    orderId: order.id,
    status: status.data,
    agreementRef: order.agreementRef,
    poNumber: order.poNumber,
    currency: order.currency,
    lines,
    totalMicros: lines
      .reduce((sum, l) => sum + BigInt(l.amountMicros), 0n)
      .toString(),
    grantOn: order.grantOn === "issue" ? "issue" : "paid",
    unitsGrantedAt: iso(order.unitsGrantedAt),
    creditsGrantedAt: iso(order.creditsGrantedAt),
    paidAt: iso(order.paidAt),
    createdAt: order.createdAt.toISOString(),
    invoice:
      invoiceStatus === null
        ? null
        : {
            number: row.invoiceNumber,
            status: invoiceStatus.data,
            dueAt: iso(row.invoiceDueAt),
            hostedInvoiceUrl: row.hostedInvoiceUrl,
            invoicePdfUrl: row.invoicePdfUrl,
          },
  };
}

// ---- The handler -----------------------------------------------------------------------

export type PrepaidOrderQueries = {
  page: (orgId: string, q: OrderPageQuery) => Promise<PrepaidOrderPageRow[]>;
};

export function createBillingPrepaidOrderListHandler(
  queries: PrepaidOrderQueries,
): CapabilityHandler<typeof billingPrepaidOrderList> {
  return async (input, ctx): Promise<BillingPrepaidOrderListOutput> => {
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Billing"] },
    );

    const cursor =
      input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw new CapabilityError(
        billingPrepaidOrderList.name,
        "invalid_input",
        "invalid_cursor",
      );

    const rows = await queries.page(ctx.orgId, { cursor, limit: input.limit });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({
              at: last.order.createdAt.toISOString(),
              id: last.order.id,
            })
          : null,
    };
  };
}

export const billingPrepaidOrderListHandler =
  createBillingPrepaidOrderListHandler({
    page: (orgId, q) =>
      withTenantDb((tx) => prepaidOrderPageQuery(tx, orgId, q)),
  });
