// Typed Billing values for the Billing component tests (ARCHITECTURE.md §5): a
// subscription, a prepaid bucket, a Free bucket with no card, an invoice-billed
// bucket, a negotiated and a published-tier rate, the retention terms, invoice
// rows and a DataSource that answers the six Billing reads with what a test
// hands it.
// Importable from tests only.
import type {
  ContractRate,
  EvidenceRetention,
  GauBucket,
  InvoicePage,
  InvoiceRow,
  PlanCard,
  UsageCredits,
} from "@/data/contracts/billing";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";

const SEPTEMBER = {
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};

type AutoTopupState = NonNullable<GauBucket["autoTopup"]>;
type InvoiceTerms = NonNullable<GauBucket["invoice"]>;

export const SUBSCRIPTION: NonNullable<PlanCard["subscription"]> = {
  plan: "build",
  status: "active",
  billingInterval: "month",
  currentPeriodStart: SEPTEMBER.start,
  currentPeriodEnd: SEPTEMBER.end,
};

/** A prepaid Build month with a saved card and headroom left. */
export function prepaidBucket(
  overrides: Partial<Omit<GauBucket, "autoTopup">> = {},
  autoTopup: Partial<AutoTopupState> = {},
): GauBucket {
  return {
    mode: "prepaid",
    period: SEPTEMBER,
    includedGau: 50000,
    purchasedGau: 5000,
    carriedGau: 1200,
    usedGau: 18200,
    remainingGau: 38000,
    invoice: null,
    autoTopup: {
      enabled: true,
      blocks: 1,
      paymentMethod: { brand: "visa", last4: "4242" },
      lastAttempt: null,
      ...autoTopup,
    },
    ...overrides,
  };
}

/** A Free month spent to zero by an organization that has saved no card. */
export function freeNoCardBucket(
  overrides: Partial<Omit<GauBucket, "autoTopup">> = {},
): GauBucket {
  return prepaidBucket(
    {
      includedGau: 5000,
      purchasedGau: 0,
      carriedGau: 0,
      usedGau: 5000,
      remainingGau: 0,
      ...overrides,
    },
    { paymentMethod: null },
  );
}

/** An invoice-billed month past its allowance. */
export function invoiceBucket(invoice: Partial<InvoiceTerms> = {}): GauBucket {
  return {
    mode: "invoice",
    period: SEPTEMBER,
    includedGau: 300000,
    purchasedGau: 0,
    carriedGau: 0,
    usedGau: 412500,
    remainingGau: -112500,
    invoice: {
      gauMax: 100000,
      uninvoicedGau: 12500,
      invoicedThisPeriodGau: 100000,
      pastDue: false,
      ...invoice,
    },
    autoTopup: null,
  };
}

/** A negotiated agreement: $0.00321 per GAU in 10,000-GAU blocks. */
export function contractRate(
  overrides: Partial<ContractRate> = {},
): ContractRate {
  return {
    source: "negotiated",
    agreementRef: "MSA-2026-014",
    tier: "enterprise",
    ratePerGau: { micros: "3210", currency: "USD" },
    blockPrice: { micros: "32100000", currency: "USD" },
    blockSizeGau: 10000,
    includedGauPerMonth: 250000,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: "2027-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The published Build tier: $5 per 1,000 GAU in 5,000-GAU blocks, open-ended. */
export const PUBLISHED_BUILD: ContractRate = {
  source: "published_tier",
  agreementRef: null,
  tier: "build",
  ratePerGau: { micros: "5000", currency: "USD" },
  blockPrice: { micros: "25000000", currency: "USD" },
  blockSizeGau: 5000,
  includedGauPerMonth: 50000,
  effectiveFrom: SEPTEMBER.start,
  effectiveTo: null,
};

/** The published retention terms: 12 months included, $0.08 a GB-month beyond, not opted in. */
export function evidenceRetention(
  overrides: Partial<EvidenceRetention> = {},
): EvidenceRetention {
  return {
    includedMonths: 12,
    perGbMonth: { micros: "80000", currency: "USD" },
    extendedRetentionEnabled: false,
    ...overrides,
  };
}

/** A usage credit balance of 4,200 credits — $42.00 at 1 credit = $0.01. */
export function usageCredits(balanceCredits = 4200): UsageCredits {
  return {
    balanceCredits,
    balance: {
      micros: String(balanceCredits * 10000),
      currency: "USD",
    },
  };
}

export function invoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: "inv_7Hc2",
    number: "OXA-0042",
    status: "paid",
    kind: "gau_auto_topup",
    amountDue: { micros: "32100000", currency: "USD" },
    amountPaid: { micros: "32100000", currency: "USD" },
    periodStart: SEPTEMBER.start,
    periodEnd: SEPTEMBER.end,
    hostedInvoiceUrl: "https://invoice.stripe.com/i/acct_1Nx/test_YWNjdF8x",
    ...overrides,
  };
}

export function invoicePage(
  items: InvoiceRow[],
  nextCursor: string | null = null,
): Read<InvoicePage> {
  return readOk({ items, nextCursor });
}

export type BillingReads = {
  plan: Read<PlanCard>;
  bucket: Read<GauBucket>;
  rate: Read<ContractRate>;
  retention: Read<EvidenceRetention>;
  invoices: Read<InvoicePage>;
  usageCredits: Read<UsageCredits>;
};

/** A DataSource answering the six Billing reads; `calls` records their arguments. */
export function billingSource(overrides: Partial<BillingReads> = {}) {
  const reads: BillingReads = {
    plan: readOk({ subscription: SUBSCRIPTION }),
    bucket: readOk(prepaidBucket()),
    rate: readOk(contractRate()),
    retention: readOk(evidenceRetention()),
    invoices: invoicePage([invoiceRow()]),
    usageCredits: readOk(usageCredits()),
    ...overrides,
  };
  const calls: Record<keyof BillingReads, unknown[][]> = {
    plan: [],
    bucket: [],
    rate: [],
    retention: [],
    invoices: [],
    usageCredits: [],
  };
  const refuse = () => Promise.reject(new Error("not a Billing read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      outputs: refuse,
      work: refuse,
      outcomesSettings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    agents: {
      list: refuse,
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    billing: {
      plan: (...args) => {
        calls.plan.push(args);
        return Promise.resolve(reads.plan);
      },
      bucket: (...args) => {
        calls.bucket.push(args);
        return Promise.resolve(reads.bucket);
      },
      contractRate: (...args) => {
        calls.rate.push(args);
        return Promise.resolve(reads.rate);
      },
      retention: (...args) => {
        calls.retention.push(args);
        return Promise.resolve(reads.retention);
      },
      invoices: (...args) => {
        calls.invoices.push(args);
        return Promise.resolve(reads.invoices);
      },
      usageCredits: (...args) => {
        calls.usageCredits.push(args);
        return Promise.resolve(reads.usageCredits);
      },
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    mandates: { list: refuse, get: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
    },
  };
  return { source, calls };
}
