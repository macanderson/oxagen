// Column-level mapping from today's billing stores to the Billing page's view
// models (src/data/contracts/billing.ts). Pure: no I/O, so every branch is
// unit-tested against rows typed from the drizzle schema and the contract.
//
// BillingPlan  ← get_subscription (billing.subscriptions ⨝ billing.plans.slug)
//                + billing.plans.tier
//   plan           plans.tier: free → free, build | scale → team,
//                  enterprise → enterprise. Any other tier is not mapped.
//   status         subscriptions.status: active → active, past_due → past_due,
//                  canceled → cancelled. trialing and paused (which
//                  get_subscription also returns) have no view-model value.
//   nextInvoiceOn  subscriptions.current_period_end (UTC day), when the
//                  subscription renews. No subscription (the free tier) and
//                  cancel_at_period_end = true both mean no next invoice, which
//                  the non-null view-model field cannot say.
//   discount       null. The view model's discount is the §12.1 onboarding /
//                  prepayment discount, a per-run-plan concept (G13) nothing
//                  grants today. Stripe checkout promotion codes are not
//                  mirrored into billing.subscriptions (see the PR's promote list).
//
// Invoice      ← billing.invoices (Stripe-mirrored headers; drafts excluded)
//   number         invoices.number (null only before Stripe finalizes)
//   period         invoices.period_start, UTC `YYYY-MM`
//   amount         invoices.amount_due_cents × 10 000 micros, invoices.currency
//   status         paid | open | void as recorded; uncollectible is not mapped
//   runs           NOT RECORDED: no store counts the runs an invoice billed (G13)
//   issuedOn       NOT RECORDED: Stripe's finalization time is not mirrored;
//                  created_at is when the webhook wrote the row, not the issue date
//
// A field the store does not record is never filled with a guess: the read
// returns `not_backed` with the milestone and gap that will record it.
import type { BillingSubscriptionReadOutput } from "@oxagen/oxagen/contracts/billing.subscription.read";
import type { schema } from "@oxagen/database";
import type { z } from "zod";
import { BillingPlan, Invoice } from "@/data/contracts";
import {
  type GapId,
  type Milestone,
  NO_GAP,
  type NotBacked,
  notBacked,
  type Read,
  readOk,
} from "@/data/not-backed";

/** The subscription get_subscription returns for an organization, when it has one. */
export type SubscriptionRead = NonNullable<
  BillingSubscriptionReadOutput["subscription"]
>;

/** `billing.plans.tier`, as the drizzle schema types it. */
export type PlanTierValue = (typeof schema.plans.$inferSelect)["tier"];

/** The `billing.invoices` columns the Invoice view model reads. */
export type InvoiceRow = Pick<
  typeof schema.invoices.$inferSelect,
  "number" | "status" | "amountDueCents" | "currency" | "periodStart"
>;

/** A view-model field today's store does not record, and what will record it. */
export type Unrecorded = {
  field: string;
  milestone: Milestone;
  gap: GapId;
};

const STORE_EXISTS = (field: string): Unrecorded => ({
  field,
  milestone: "M0",
  gap: NO_GAP,
});

/** Runs per invoice arrive with the per-run billing allowance (plan §3.4 G13). */
const RUNS_UNRECORDED: Unrecorded = {
  field: "runs",
  milestone: "M2",
  gap: "G13",
};
/** Stripe's finalization instant is not mirrored into billing.invoices. */
const ISSUED_ON_UNRECORDED = STORE_EXISTS("issuedOn");

const PLAN_BY_TIER: Readonly<Record<string, BillingPlan["plan"]>> = {
  free: "free",
  build: "team",
  scale: "team",
  enterprise: "enterprise",
};

const PLAN_STATUS: Readonly<Record<string, BillingPlan["status"]>> = {
  active: "active",
  past_due: "past_due",
  canceled: "cancelled",
};

const INVOICE_STATUS: Readonly<Record<string, Invoice["status"]>> = {
  paid: "paid",
  open: "open",
  void: "void",
};

const MILESTONE_ORDER: readonly Milestone[] = [
  "M0",
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "spec-decision",
];

/**
 * The one `not_backed` a read reports when several fields are unrecorded: the
 * latest milestone, since the read stays unbacked until that one lands.
 */
export function latestGap(unrecorded: readonly Unrecorded[]): NotBacked {
  const [first, ...rest] = unrecorded;
  if (!first) throw new Error("latestGap needs at least one unrecorded field");
  const latest = rest.reduce(
    (a, b) =>
      MILESTONE_ORDER.indexOf(b.milestone) >
      MILESTONE_ORDER.indexOf(a.milestone)
        ? b
        : a,
    first,
  );
  return notBacked(latest.milestone, latest.gap);
}

/** `2026-10-01T00:00:00.000Z` → `2026-10-01`, in UTC. */
function utcDay(instant: string | Date): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** micro-units from integer cents, exactly (no float arithmetic). */
export function centsToMicros(cents: number): string {
  if (!Number.isSafeInteger(cents))
    throw new RangeError(`cents must be a safe integer, got ${cents}`);
  return (BigInt(cents) * 10_000n).toString();
}

export type PlanInput = {
  /** get_subscription's `subscription`: null when the organization has none. */
  subscription: SubscriptionRead | null;
  /** `billing.plans.tier` for the subscription's plan slug; null when no plan row matched. */
  tier: PlanTierValue | null;
};

/** A value from a vocabulary table, own keys only (never `toString` off the prototype). */
function lookup<V>(
  table: Readonly<Record<string, V>>,
  key: string | null,
): V | null {
  return key !== null && Object.hasOwn(table, key)
    ? (table[key] ?? null)
    : null;
}

export function toBillingPlan(input: PlanInput): Read<BillingPlan> {
  const { subscription, tier } = input;
  if (!subscription)
    // No subscription (the free tier): no plan row, no status, no next invoice.
    return latestGap([
      STORE_EXISTS("plan"),
      STORE_EXISTS("status"),
      STORE_EXISTS("nextInvoiceOn"),
    ]);
  const plan = lookup(PLAN_BY_TIER, tier);
  const status = lookup(PLAN_STATUS, subscription.status);
  const renews = !subscription.cancelAtPeriodEnd;
  if (plan === null || status === null || !renews)
    return latestGap([
      ...(plan === null ? [STORE_EXISTS("plan")] : []),
      ...(status === null ? [STORE_EXISTS("status")] : []),
      ...(renews ? [] : [STORE_EXISTS("nextInvoiceOn")]),
    ]);
  return readOk(
    BillingPlan.parse({
      plan,
      status,
      nextInvoiceOn: utcDay(subscription.currentPeriodEnd),
      discount: null,
    }),
  );
}

/** The Invoice fields billing.invoices records, parsed through the view model. */
export const RecordedInvoice = Invoice.pick({
  number: true,
  period: true,
  amount: true,
  status: true,
});
export type RecordedInvoice = z.infer<typeof RecordedInvoice>;

export type InvoiceMapping = {
  /**
   * The recorded fields, parsed through the view model so a column that stops
   * matching fails loudly today; null when a recorded column has no view-model
   * value. They become the Invoice once its unrecorded fields are recorded.
   */
  recorded: RecordedInvoice | null;
  unrecorded: Unrecorded[];
};

/** Whether Stripe has issued the invoice. A draft is not an invoice yet. */
export function isIssued(row: Pick<InvoiceRow, "status">): boolean {
  return row.status !== "draft";
}

export function toInvoiceMapping(row: InvoiceRow): InvoiceMapping {
  const unrecorded: Unrecorded[] = [RUNS_UNRECORDED, ISSUED_ON_UNRECORDED];
  const status = lookup(INVOICE_STATUS, row.status);
  if (status === null) unrecorded.push(STORE_EXISTS("status"));
  if (row.number === null) unrecorded.push(STORE_EXISTS("number"));
  if (status === null || row.number === null)
    return { recorded: null, unrecorded };
  return {
    recorded: RecordedInvoice.parse({
      number: row.number,
      period: row.periodStart.toISOString().slice(0, 7),
      amount: {
        micros: centsToMicros(row.amountDueCents),
        currency: row.currency.toUpperCase(),
      },
      status,
    }),
    unrecorded,
  };
}

/**
 * The organization's issued invoices. An organization with none has an honest
 * empty list; one with any cannot be shown without inventing each invoice's run
 * count and issue date, so the read names the gap instead.
 */
export function readInvoices(rows: readonly InvoiceRow[]): Read<Invoice[]> {
  const issued = rows.filter(isIssued);
  if (issued.length === 0) return readOk(Invoice.array().parse([]));
  return latestGap(issued.flatMap((row) => toInvoiceMapping(row).unrecorded));
}
