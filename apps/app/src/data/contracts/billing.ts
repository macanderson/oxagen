// The Billing page's view models (ARCHITECTURE.md §1.4, §3.9), from
// get_subscription, get_gau_bucket, get_contract_rate, get_evidence_retention
// and list_invoices. On the
// governed action meter every figure except the contracted rate, the block
// price and an invoice's amounts is a GAU count or a date; the second meter,
// in-app AI usage credits, carries its balance's face value. Only
// ContractRate, EvidenceRetention, InvoicePage and UsageCredits reach a Money
// (INV-25, src/test/arch/billing-units.test.ts). Token usage has no view model
// (§1.4); stored evidence volume is null until a job measures it.
import { z } from "zod";
import { PublicId } from "./common";
import { Money } from "./money";

const Count = z.number().int().nonnegative();
const Instant = z.iso.datetime();

/** The subscription the organization is billed under; null for an organization with none. */
export const PlanCard = z.object({
  subscription: z
    .object({
      plan: z.string().min(1),
      status: z.string().min(1),
      billingInterval: z.enum(["month", "year"]),
      currentPeriodStart: Instant,
      currentPeriodEnd: Instant,
    })
    .nullable(),
});
export type PlanCard = z.infer<typeof PlanCard>;

/**
 * One month of governed action units. `invoice` is non-null exactly in invoice
 * mode and `autoTopup` exactly in prepaid; `remainingGau` is negative when the
 * bucket is overdrawn and is printed as stored.
 */
export const GauBucket = z.object({
  mode: z.enum(["prepaid", "invoice"]),
  period: z.object({ start: Instant, end: Instant }),
  includedGau: Count,
  purchasedGau: Count,
  carriedGau: Count,
  usedGau: Count,
  remainingGau: z.number().int(),
  invoice: z
    .object({
      gauMax: z.number().int().positive(),
      uninvoicedGau: Count,
      invoicedThisPeriodGau: Count,
      pastDue: z.boolean(),
    })
    .nullable(),
  autoTopup: z
    .object({
      enabled: z.boolean(),
      blocks: z.number().int().positive(),
      paymentMethod: z
        .object({ brand: z.string().nullable(), last4: z.string().nullable() })
        .nullable(),
      lastAttempt: z
        .object({ at: Instant, status: z.enum(["paid", "open", "failed"]) })
        .nullable(),
    })
    .nullable(),
});
export type GauBucket = z.infer<typeof GauBucket>;

/** The customer's contracted terms, read live: a negotiated agreement or the published tier. */
export const ContractRate = z.object({
  source: z.enum(["published_tier", "negotiated"]),
  agreementRef: z.string().min(1).nullable(),
  tier: z.enum(["free", "build", "scale", "enterprise"]),
  ratePerGau: Money,
  /** `ratePerGau × blockSizeGau`, computed with mulMicros. */
  blockPrice: Money,
  blockSizeGau: z.number().int().positive(),
  includedGauPerMonth: Count,
  effectiveFrom: Instant,
  effectiveTo: Instant.nullable(),
});
export type ContractRate = z.infer<typeof ContractRate>;

const InvoiceRow = z.object({
  id: PublicId,
  number: z.string().min(1).nullable(),
  status: z.enum(["open", "paid", "uncollectible", "void"]),
  kind: z.enum([
    "subscription",
    "gau_purchase",
    "gau_auto_topup",
    "gau_interim",
    "gau_period_close",
  ]),
  amountDue: Money,
  amountPaid: Money,
  periodStart: Instant,
  periodEnd: Instant,
  hostedInvoiceUrl: z.string().min(1).nullable(),
});

/** One cursor page of invoices, newest first. */
export const InvoicePage = z.object({
  items: z.array(InvoiceRow),
  nextCursor: z.string().min(1).nullable(),
});
export type InvoicePage = z.infer<typeof InvoicePage>;
export type InvoiceRow = InvoicePage["items"][number];

/**
 * The second meter (§3.9): the in-app AI usage credit balance that pays for
 * the in-app agent's model calls. One credit is $0.01, so `balance` is
 * `balanceCredits` at face value — the same figure in the two units the page
 * prints it in. The balance goes negative when a turn settles past zero, and
 * is printed as stored.
 */
export const UsageCredits = z.object({
  balanceCredits: z.number().int(),
  balance: Money,
});
export type UsageCredits = z.infer<typeof UsageCredits>;

/**
 * Evidence retention (pages/billing.md, the Retained evidence tile, line and
 * meter): the months every paid plan includes, the published price per
 * GB-month beyond them, and whether this organization has opted into paying
 * for that. The volume the organization holds has no field: the contract
 * reports only the volume beyond the included window, and no job measures
 * even that yet, so the page prints "not recorded" for it.
 */
export const EvidenceRetention = z.object({
  includedMonths: z.number().int().positive(),
  perGbMonth: Money,
  extendedRetentionEnabled: z.boolean(),
});
export type EvidenceRetention = z.infer<typeof EvidenceRetention>;
