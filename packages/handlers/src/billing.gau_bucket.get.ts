// billing.gau_bucket.get.ts — handler for the get_gau_bucket capability.
//
// audit-exempt: read-only. Reports the organization's own governed action
// unit bucket for the current month; no state changes, nothing privileged is
// disclosed, and the kernel's capability.invoke_* audit records the access.
//
// The month comes from `periodFor` (the subscription's anniversary slice, or
// the UTC calendar month for an organization with none), the counts from
// `readBucket` — a virtual bucket carrying the previous month's carry when no
// row exists yet — the mode and the auto top-up preferences from
// `readOrgBillingSettings`, and the saved card from
// `readDefaultPaymentMethod`. Every one of those is a SELECT: a read never
// writes, so the page cannot create the month's bucket by being opened and
// `get_gau_bucket` cannot race the recorder's lazy create
// (apps/app/ARCHITECTURE.md §3.9 items 5, 6 and 9, ADR-055 §4–5).
//
// The mode decides which half of the answer is filled in. Invoice billing
// reports the threshold state — the cap, the overage accrued since the last
// interim invoice, what this month's interim and period-close settlements
// have claimed, and whether one of them is finalized and unpaid. Prepaid
// reports auto top-up: the toggle, the blocks per top-up, the saved card and
// the latest episode of the month. An organization an operator has not
// approved for invoice billing reports no cap at all, whatever
// `org_billing_settings.invoice_gau_max` holds for it: the column is stored
// and inert in prepaid, and a cap on the page would be a number with no
// effect anywhere.
//
// No money crosses this handler. The contracted rate is get_contract_rate's
// and the invoice amounts are list_invoices' (INV-09, INV-25).
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner, Admin or Billing, for the
//      signed-in user or the creator of the API key. The kernel's
//      IAM check allows every capability for a non-enterprise org, so the
//      handler owns this check (apps/app/ARCHITECTURE.md §3.2, INV-29).
//   2. Resolve the terms and the subscription, the settings, and the month.
//   3. Read the bucket, and the settlement state its mode needs.

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  billingGauBucketGet,
  type BillingGauBucketGetOutput,
} from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import {
  periodFor,
  readBucket,
  readDefaultPaymentMethod,
  readOrgBillingSettings,
  resolveGauEntitlement,
  uninvoicedGau,
  type DefaultPaymentMethod,
  type GauBucketView,
  type GauEntitlement,
  type GauPeriod,
  type GauTerms,
  type OrgGauBillingSettings,
} from "@oxagen/billing";
import { schema, type Tx, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { and, desc, eq, inArray } from "drizzle-orm";

// ---- Settlement reads ------------------------------------------------------

/** The statuses `lastAttempt` can name; a `pending` row has none of them. */
const SETTLED_STATUSES = ["paid", "open", "failed"] as const;

type SettledStatus = (typeof SETTLED_STATUSES)[number];

/** The latest auto top-up episode of a bucket, as the page prints it. */
export type AutoTopupAttempt = { at: Date; status: SettledStatus };

const settlements = schema.gauSettlements;

/** What the settlement queries need from a transaction: the select builder. */
type QueryDb = Pick<Tx, "select">;

/**
 * Is an overage invoice of this bucket finalized and unpaid?
 *
 * `open` means Stripe holds a finalized invoice and owns collection from
 * there. The organization keeps running either way — rev1 suspends nobody for
 * an unpaid interim invoice — so this is the "payment past due" line and
 * nothing more. A row that reaches `paid` clears it (ADR-055 §6).
 */
export function pastDueQuery(db: QueryDb, orgId: string, bucketId: string) {
  return db
    .select({ id: settlements.id })
    .from(settlements)
    .where(
      and(
        eq(settlements.orgId, orgId),
        eq(settlements.bucketId, bucketId),
        inArray(settlements.kind, ["interim_invoice", "period_close"]),
        eq(settlements.status, "open"),
      ),
    )
    .limit(1);
}

/**
 * The latest auto top-up episode of the bucket that reached a state the page
 * can name. A `pending` row is a claim whose provider call Stripe has not
 * answered yet; the close job resumes it, and until it does there is no
 * outcome to print.
 */
export function lastAutoTopupQuery(
  db: QueryDb,
  orgId: string,
  bucketId: string,
) {
  return db
    .select({ at: settlements.createdAt, status: settlements.status })
    .from(settlements)
    .where(
      and(
        eq(settlements.orgId, orgId),
        eq(settlements.bucketId, bucketId),
        eq(settlements.kind, "auto_topup"),
        inArray(settlements.status, [...SETTLED_STATUSES]),
      ),
    )
    .orderBy(desc(settlements.createdAt), desc(settlements.id))
    .limit(1);
}

// ---- Dependencies ----------------------------------------------------------

/** The reads the handler makes. Every one runs inside the kernel's tenant scope. */
type GauBucketQueries = {
  entitlement: (orgId: string, now: Date) => Promise<GauEntitlement>;
  settings: (orgId: string) => Promise<OrgGauBillingSettings>;
  bucket: (
    orgId: string,
    args: { period: GauPeriod; terms: GauTerms },
  ) => Promise<GauBucketView>;
  defaultPaymentMethod: (orgId: string) => Promise<DefaultPaymentMethod | null>;
  pastDue: (orgId: string, bucketId: string) => Promise<boolean>;
  lastAutoTopup: (
    orgId: string,
    bucketId: string,
  ) => Promise<AutoTopupAttempt | null>;
};

export const postgresGauBucketQueries: GauBucketQueries = {
  entitlement: resolveGauEntitlement,
  settings: readOrgBillingSettings,
  bucket: readBucket,
  defaultPaymentMethod: readDefaultPaymentMethod,
  pastDue: async (orgId, bucketId) => {
    const rows = await withTenantDb((tx) => pastDueQuery(tx, orgId, bucketId));
    return rows.length > 0;
  },
  lastAutoTopup: async (orgId, bucketId) => {
    const rows = await withTenantDb((tx) =>
      lastAutoTopupQuery(tx, orgId, bucketId),
    );
    const row = rows[0];
    if (!row) return null;
    if (!(SETTLED_STATUSES as readonly string[]).includes(row.status))
      throw new RangeError(
        `auto top-up status outside the list: ${row.status}`,
      );
    return { at: row.at, status: row.status as SettledStatus };
  },
};

// ---- The handler -----------------------------------------------------------

export function createBillingGauBucketGetHandler(
  queries: GauBucketQueries,
): CapabilityHandler<typeof billingGauBucketGet> {
  return async (_input, ctx): Promise<BillingGauBucketGetOutput> => {
    // ── Role gate ─────────────────────────────────────────────────────────
    await assertOrgRole(
      { ...ctx, userId: await resolveActingUserId(ctx) },
      { org: ["Owner", "Admin", "Billing"] },
    );

    const orgId = ctx.orgId;
    const now = new Date();

    // ── Terms, settings, month ────────────────────────────────────────────
    const [{ terms, subscription }, settings] = await Promise.all([
      queries.entitlement(orgId, now),
      queries.settings(orgId),
    ]);
    const period = periodFor(subscription, now);
    const bucket = await queries.bucket(orgId, { period, terms });

    const counts = {
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
      },
      includedGau: bucket.includedGau,
      purchasedGau: bucket.purchasedGau,
      carriedGau: bucket.carriedGau,
      usedGau: bucket.usedGau,
      remainingGau: bucket.remainingGau,
    };

    // ── Invoice billing: the threshold state ──────────────────────────────
    if (settings.approvedForInvoiceBilling) {
      return {
        mode: "invoice",
        ...counts,
        invoice: {
          gauMax: settings.invoiceGauMax,
          uninvoicedGau: uninvoicedGau(bucket),
          invoicedThisPeriodGau: bucket.overageInvoicedGau,
          // A virtual bucket has no settlements: nothing has been claimed
          // against a month that has recorded no action.
          pastDue:
            bucket.id === null
              ? false
              : await queries.pastDue(orgId, bucket.id),
        },
        autoTopup: null,
      };
    }

    // ── Prepaid: the auto top-up state ────────────────────────────────────
    const [card, attempt] = await Promise.all([
      queries.defaultPaymentMethod(orgId),
      bucket.id === null
        ? Promise.resolve(null)
        : queries.lastAutoTopup(orgId, bucket.id),
    ]);
    return {
      mode: "prepaid",
      ...counts,
      invoice: null,
      autoTopup: {
        enabled: settings.autoTopupEnabled,
        blocks: settings.autoTopupBlocks,
        paymentMethod:
          card === null ? null : { brand: card.brand, last4: card.last4 },
        lastAttempt:
          attempt === null
            ? null
            : { at: attempt.at.toISOString(), status: attempt.status },
      },
    };
  };
}

export const billingGauBucketGetHandler = createBillingGauBucketGetHandler(
  postgresGauBucketQueries,
);
