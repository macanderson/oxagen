// billing.invoice.list.ts — handler for the list_invoices capability.
//
// audit-exempt: read-only. Lists the organization's own invoice headers from
// the webhook mirror; no state changes, nothing privileged is disclosed, and
// the kernel's capability.invoke_* audit records the access.
//
// The list is `billing.invoices`, kept current by syncInvoiceFromStripe
// (packages/billing/src/invoices.ts) from Stripe's invoice.* events, LEFT
// JOINed to `billing.gau_settlements` on stripe_invoice_id for the kind of
// charge each invoice settled. An invoice no settlement names is the
// subscription's own. A settlement names at most one invoice — the ledger
// creates it with the settlement id as the Stripe idempotency key — so the
// join adds a column, never a row.
//
// Drafts are excluded: the ledger's own draft (`auto_advance: false`) is not
// collectable until the recorder finalizes it, and Stripe's subscription
// drafts finalize on their own an hour later. Newest first by the mirror
// row's created_at, keyset-paged on an opaque cursor.
//
// The kernel enters the tenant scope before this handler runs, so the read
// goes through withTenantDb, whose RLS is the tenant filter. The query ALSO
// names org_id: a local stack runs with the RLS bypass on, and another
// organization's invoice must still stay out of the list.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner, Admin or Billing, for the
//      signed-in user or the creator of the API key. The kernel's
//      IAM check allows every capability for a non-enterprise org, so the
//      handler owns this check (apps/app/ARCHITECTURE.md §3.2, INV-29).
//   2. Decode the cursor; a cursor this handler did not write is
//      invalid_input.
//   3. Read one row past the page, map, and encode the next cursor.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingInvoiceList,
  type BillingInvoiceListOutput,
  type InvoiceItem,
  type InvoiceKind,
  invoiceStatusSchema,
} from "@oxagen/oxagen/contracts/billing.invoice.list";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, desc, eq, lt, ne, or, type SQL, sql } from "drizzle-orm";

// ---- Cursor -------------------------------------------------------------------------

/** Where a page ended: the last row's mirror creation instant and row id. */
type InvoiceCursor = { at: string; id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeInvoiceCursor(cursor: InvoiceCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString(
    "base64url",
  );
}

/** Null for anything that is not a cursor this handler wrote. */
export function decodeInvoiceCursor(raw: string): InvoiceCursor | null {
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

/** What the query needs from a transaction: the select builder. */
type QueryDb = Pick<Tx, "select">;

export type PageQuery = { cursor: InvoiceCursor | null; limit: number };

const invoices = schema.invoices;
const settlements = schema.gauSettlements;

/** Millisecond precision, so a cursor built from a JS Date compares exactly. */
const createdAtMs = sql`date_trunc('milliseconds', ${invoices.createdAt})`;

/** Newest first from the cursor, ties broken on the row id (uuid, byte order). */
function beforeCursor(cursor: InvoiceCursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const instant = new Date(cursor.at);
  return or(
    lt(createdAtMs, instant),
    and(eq(createdAtMs, instant), lt(invoices.id, cursor.id)),
  );
}

/**
 * The organization's non-draft invoices, newest first, with the kind of the
 * settlement that names each one (null for the subscription's own). Reads one
 * row past the page so the caller knows whether a next page exists.
 */
export function invoicePageQuery(db: QueryDb, orgId: string, q: PageQuery) {
  return db
    .select({
      id: invoices.id,
      publicId: invoices.publicId,
      number: invoices.number,
      status: invoices.status,
      amountDueCents: invoices.amountDueCents,
      amountPaidCents: invoices.amountPaidCents,
      currency: invoices.currency,
      periodStart: invoices.periodStart,
      periodEnd: invoices.periodEnd,
      hostedInvoiceUrl: invoices.hostedInvoiceUrl,
      createdAt: invoices.createdAt,
      settlementKind: settlements.kind,
    })
    .from(invoices)
    .leftJoin(
      settlements,
      and(
        eq(settlements.stripeInvoiceId, invoices.stripeInvoiceId),
        eq(settlements.orgId, invoices.orgId),
      ),
    )
    .where(
      and(
        eq(invoices.orgId, orgId),
        ne(invoices.status, "draft"),
        beforeCursor(q.cursor),
      ),
    )
    .orderBy(desc(createdAtMs), desc(invoices.id))
    .limit(q.limit + 1);
}

/** One row of the page query. */
export type InvoiceRow = {
  id: string;
  publicId: string;
  number: string | null;
  /** `invoices.status` (CHECK: draft, open, paid, uncollectible, void). */
  status: string;
  amountDueCents: number;
  amountPaidCents: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  hostedInvoiceUrl: string | null;
  createdAt: Date;
  /** `gau_settlements.kind` of the settlement naming this invoice, or null. */
  settlementKind: string | null;
};

// ---- Mapping --------------------------------------------------------------------------

const SETTLEMENT_KIND: Readonly<Record<string, InvoiceKind>> = {
  checkout: "gau_purchase",
  auto_topup: "gau_auto_topup",
  interim_invoice: "gau_interim",
  period_close: "gau_period_close",
};

/**
 * The settlement's kind → the invoice's kind; no settlement → the
 * subscription's own invoice. A word outside the column's CHECK is a broken
 * row, and the read fails rather than guesses.
 */
export function invoiceKind(settlementKind: string | null): InvoiceKind {
  if (settlementKind === null) return "subscription";
  const mapped = Object.hasOwn(SETTLEMENT_KIND, settlementKind)
    ? SETTLEMENT_KIND[settlementKind]
    : undefined;
  if (!mapped)
    throw new RangeError(
      `settlement kind outside the CHECK: ${settlementKind}`,
    );
  return mapped;
}

/** The mirrored status; the query excludes drafts, so any other word is a broken row. */
function invoiceStatus(status: string): InvoiceItem["status"] {
  const parsed = invoiceStatusSchema.safeParse(status);
  if (!parsed.success)
    throw new RangeError(`invoice status outside the list: ${status}`);
  return parsed.data;
}

/** Stripe's integer cents as the wire's integer micro-units, as a decimal string. */
export function centsToMicros(cents: number): string {
  if (!Number.isSafeInteger(cents))
    throw new RangeError(
      `invoice cents must be a safe integer: ${String(cents)}`,
    );
  return (BigInt(cents) * 10_000n).toString();
}

function toInvoiceItem(row: InvoiceRow): InvoiceItem {
  return {
    publicId: row.publicId,
    number: row.number,
    status: invoiceStatus(row.status),
    kind: invoiceKind(row.settlementKind),
    amountDueMicros: centsToMicros(row.amountDueCents),
    amountPaidMicros: centsToMicros(row.amountPaidCents),
    currency: row.currency,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    hostedInvoiceUrl: row.hostedInvoiceUrl,
  };
}

// ---- Dependencies ---------------------------------------------------------------------

/** The read the handler makes. Runs inside the kernel's tenant scope. */
type InvoiceQueries = {
  page: (orgId: string, q: PageQuery) => Promise<InvoiceRow[]>;
};

export const postgresInvoiceQueries: InvoiceQueries = {
  page: (orgId, q) => withTenantDb((tx) => invoicePageQuery(tx, orgId, q)),
};

// ---- The handler -----------------------------------------------------------------------

export function createBillingInvoiceListHandler(
  queries: InvoiceQueries,
): CapabilityHandler<typeof billingInvoiceList> {
  return async (input, ctx): Promise<BillingInvoiceListOutput> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Billing"] },
    );

    // ── Cursor ────────────────────────────────────────────────────────────
    const cursor =
      input.cursor === undefined ? null : decodeInvoiceCursor(input.cursor);
    if (input.cursor !== undefined && cursor === null)
      throw new CapabilityError(
        billingInvoiceList.name,
        "invalid_input",
        "invalid_cursor",
      );

    // ── Read ──────────────────────────────────────────────────────────────
    const rows = await queries.page(ctx.orgId, { cursor, limit: input.limit });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(toInvoiceItem),
      nextCursor:
        rows.length > input.limit && last
          ? encodeInvoiceCursor({
              at: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  };
}

export const billingInvoiceListHandler = createBillingInvoiceListHandler(
  postgresInvoiceQueries,
);
