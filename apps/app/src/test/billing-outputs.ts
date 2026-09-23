// Contract-output samples for the billing mapper and adapter tests
// (ARCHITECTURE.md §5): what get_subscription, get_gau_bucket,
// get_contract_rate, get_evidence_retention and list_invoices answer for a prepaid Build organization,
// an invoice-billed organization and a negotiated customer. Test support
// only: src/test is never in a production bundle.
import type { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import type { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import type { billingGauBucketGet } from "@oxagen/oxagen/contracts/billing.gau_bucket.get";
import type { billingInvoiceList } from "@oxagen/oxagen/contracts/billing.invoice.list";
import type { billingSubscriptionRead } from "@oxagen/oxagen/contracts/billing.subscription.read";
import type { ContractOutput } from "@/server/kernel";

type SubscriptionOutput = ContractOutput<typeof billingSubscriptionRead>;
type GauBucketOutput = ContractOutput<typeof billingGauBucketGet>;
type ContractRateOutput = ContractOutput<typeof billingContractRateGet>;
type InvoiceListOutput = ContractOutput<typeof billingInvoiceList>;
type EvidenceRetentionOutput = ContractOutput<typeof billingEvidenceRetention>;
type InvoiceItemOutput = InvoiceListOutput["items"][number];

const SEPTEMBER = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};

export function subscriptionOutput(
  overrides: Partial<SubscriptionOutput> = {},
): SubscriptionOutput {
  return {
    subscription: {
      publicId: "sub_8Qm2",
      status: "active",
      planSlug: "build",
      billingInterval: "month",
      currentPeriodStart: SEPTEMBER.start,
      currentPeriodEnd: SEPTEMBER.end,
      cancelAtPeriodEnd: false,
      seatCount: 5,
    },
    creditBalanceCents: 4200,
    periodUsage: {
      inputTokens: 1200,
      outputTokens: 300,
      cachedTokens: 40,
      costMicros: 912000,
      executions: 7,
    },
    ...overrides,
  };
}

export function prepaidBucketOutput(
  overrides: Partial<GauBucketOutput> = {},
): GauBucketOutput {
  return {
    mode: "prepaid",
    period: SEPTEMBER,
    includedGau: 50000,
    purchasedGau: 5000,
    carriedGau: 1200,
    usedGau: 58450,
    remainingGau: -2250,
    invoice: null,
    autoTopup: {
      enabled: true,
      blocks: 2,
      paymentMethod: { brand: "visa", last4: "4242" },
      lastAttempt: { at: "2026-09-14T10:02:00.000Z", status: "open" },
    },
    ...overrides,
  };
}

export function invoiceBucketOutput(): GauBucketOutput {
  return {
    mode: "invoice",
    period: SEPTEMBER,
    includedGau: 300000,
    purchasedGau: 1,
    carriedGau: 2,
    usedGau: 412503,
    remainingGau: -112500,
    invoice: {
      gauMax: 100000,
      uninvoicedGau: 12500,
      invoicedThisPeriodGau: 100000,
      pastDue: true,
    },
    autoTopup: null,
  };
}

/** A negotiated agreement at a rate no published band carries. */
export function contractRateOutput(
  overrides: Partial<ContractRateOutput> = {},
): ContractRateOutput {
  return {
    source: "negotiated",
    agreementRef: "MSA-2026-014",
    tier: "enterprise",
    currency: "usd",
    ratePerGauMicros: "3210",
    blockSizeGau: 10000,
    includedGauPerMonth: 250000,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function invoiceItemOutput(
  overrides: Partial<InvoiceItemOutput> = {},
): InvoiceItemOutput {
  return {
    publicId: "inv_7Hc2",
    number: "OXA-0042",
    status: "paid",
    kind: "gau_auto_topup",
    amountDueMicros: "50000000",
    amountPaidMicros: "50000000",
    currency: "usd",
    periodStart: SEPTEMBER.start,
    periodEnd: SEPTEMBER.end,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x",
    ...overrides,
  };
}

/** The published retention posture: 12 months included, $0.08 a GB-month, not opted in, nothing measured. */
export function evidenceRetentionOutput(
  overrides: Partial<EvidenceRetentionOutput> = {},
): EvidenceRetentionOutput {
  return {
    includedMonths: 12,
    effectiveRetentionDays: null,
    extendedRetentionEnabled: false,
    usdPerGbMonth: 0.08,
    storedGbBeyondIncluded: null,
    storedGbMeasured: false,
    creditsChargedThisPeriod: 0,
    ...overrides,
  };
}
