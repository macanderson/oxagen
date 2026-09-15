// The Billing page's view models (ARCHITECTURE.md §1.4, §3.9), from
// get_subscription, get_gau_bucket, get_contract_rate and list_invoices. Every
// figure except the contracted rate, the block price and an invoice's amounts
// is a GAU count or a date: only ContractRate and InvoicePage carry a Money
// (INV-25, src/test/arch/billing-units.test.ts). Token usage and stored
// evidence volume have no view model (§1.4).
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
