// get_subscription, get_gau_bucket, get_contract_rate and list_invoices outputs
// to the Billing page's view models (ARCHITECTURE.md §3.4, §3.9). Typed from
// the contracts' `_output`. The subscription mapper takes a Pick of its output
// holding the subscription alone, so the credit balance and the token usage
// that contract also reports cannot reach the page (INV-25). Money is built
// only from the contracted per-GAU rate and the invoice amounts, in the
// currency the contract names.
import type { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import type { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import type { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import type { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import type { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import type { z } from "zod";
import type {
  ContractRate,
  EvidenceRetention,
  GauBucket,
  InvoicePage,
  PlanCard,
  UsageCredits,
} from "@/data/contracts/billing";
import type { Money } from "@/data/contracts/money";
import {
  microsFromDecimal,
  moneyFromMicros,
  mulMicros,
} from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";

export function toPlanCard(
  out: Pick<ContractOutput<typeof billingSubscriptionRead>, "subscription">,
): z.input<typeof PlanCard> {
  const { subscription } = out;
  return {
    subscription:
      subscription === null
        ? null
        : {
            plan: subscription.planSlug,
            status: subscription.status,
            billingInterval: subscription.billingInterval,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
          },
  };
}

/**
 * One credit at face value: $0.01, which is 10,000 micro-dollars
 * (`CREDIT_VALUE_USD`, packages/billing/src/pricing.ts). Multiplying it by the
 * balance is how the face value is derived, so no arithmetic on micros happens
 * outside `money.ts` (INV-09).
 */
const CREDIT_FACE_VALUE: Money = { micros: "10000", currency: "USD" };

/**
 * The second meter (§3.9). The parameter is a Pick of the contract output
 * holding the credit balance alone, so the token usage `get_subscription` also
 * reports cannot reach the page through this mapper (§1.4, INV-25).
 */
export function toUsageCredits(
  out: Pick<
    ContractOutput<typeof billingSubscriptionRead>,
    "creditBalanceCents"
  >,
): z.input<typeof UsageCredits> {
  const balanceCredits = out.creditBalanceCents;
  return {
    balanceCredits,
    balance: mulMicros(CREDIT_FACE_VALUE, balanceCredits),
  };
}

export function toGauBucket(
  out: ContractOutput<typeof billingGauBucketGet>,
): z.input<typeof GauBucket> {
  const { invoice, autoTopup } = out;
  return {
    mode: out.mode,
    period: { start: out.period.start, end: out.period.end },
    includedGau: out.includedGau,
    purchasedGau: out.purchasedGau,
    carriedGau: out.carriedGau,
    usedGau: out.usedGau,
    remainingGau: out.remainingGau,
    invoice:
      invoice === null
        ? null
        : {
            gauMax: invoice.gauMax,
            uninvoicedGau: invoice.uninvoicedGau,
            invoicedThisPeriodGau: invoice.invoicedThisPeriodGau,
            pastDue: invoice.pastDue,
          },
    autoTopup:
      autoTopup === null
        ? null
        : {
            enabled: autoTopup.enabled,
            blocks: autoTopup.blocks,
            paymentMethod:
              autoTopup.paymentMethod === null
                ? null
                : {
                    brand: autoTopup.paymentMethod.brand,
                    last4: autoTopup.paymentMethod.last4,
                  },
            lastAttempt:
              autoTopup.lastAttempt === null
                ? null
                : {
                    at: autoTopup.lastAttempt.at,
                    status: autoTopup.lastAttempt.status,
                  },
          },
  };
}

/** Stripe and billing.plans store the currency lower case; ISO 4217 prints it upper case. */
const isoCurrency = (currency: string): string => currency.toUpperCase();

export function toContractRate(
  out: ContractOutput<typeof billingContractRateGet>,
): z.input<typeof ContractRate> {
  const ratePerGau = moneyFromMicros(
    out.ratePerGauMicros,
    isoCurrency(out.currency),
  );
  return {
    source: out.source,
    agreementRef: out.agreementRef,
    tier: out.tier,
    ratePerGau,
    blockPrice: mulMicros(ratePerGau, out.blockSizeGau),
    blockSizeGau: out.blockSizeGau,
    includedGauPerMonth: out.includedGauPerMonth,
    effectiveFrom: out.effectiveFrom,
    effectiveTo: out.effectiveTo,
  };
}

export function toInvoicePage(
  out: ContractOutput<typeof billingInvoiceList>,
): z.input<typeof InvoicePage> {
  return {
    items: out.items.map((item) => {
      const currency = isoCurrency(item.currency);
      return {
        id: item.publicId,
        number: item.number,
        status: item.status,
        kind: item.kind,
        amountDue: moneyFromMicros(item.amountDueMicros, currency),
        amountPaid: moneyFromMicros(item.amountPaidMicros, currency),
        periodStart: item.periodStart,
        periodEnd: item.periodEnd,
        hostedInvoiceUrl: item.hostedInvoiceUrl,
      };
    }),
    nextCursor: out.nextCursor,
  };
}

/**
 * get_evidence_retention (pages/billing.md, Retained evidence). The contract
 * prices a GB-month in dollars as a number; it is read back through its
 * decimal text into micros, so no float carries the price (INV-09). A price
 * that text cannot hold as micros fails the view model's parse and the page
 * says so. The volume is copied only when the contract says it was measured:
 * `storedGbMeasured: false` is an absence, and null says so.
 */
export function toEvidenceRetention(
  out: ContractOutput<typeof billingEvidenceRetention>,
): z.input<typeof EvidenceRetention> {
  return {
    includedMonths: out.includedMonths,
    perGbMonth: {
      micros: microsFromDecimal(String(out.usdPerGbMonth)) ?? "",
      currency: "USD",
    },
    extendedRetentionEnabled: out.extendedRetentionEnabled,
    storedGb: out.storedGbMeasured ? out.storedGbBeyondIncluded : null,
  };
}
