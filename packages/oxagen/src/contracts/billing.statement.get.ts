/**
 * `get_billing_statement`: the organization's billing statement for one
 * period, as structured data (ADR-158). A period is a UTC calendar week
 * (Monday to Sunday), month, quarter or year containing an anchor date, or a
 * custom range longer than 48 hours and at most 366 days.
 *
 * The statement is what a finance team reconciles an invoice against. Every
 * figure is read from a ledger, and the `reconciliation` list names each
 * identity the figures satisfy, with whether it held:
 *
 *   - Governed action units come from `billing.gau_ledger`, selected on
 *     `billed_at`, the instant the units were added to a month bucket. That is
 *     the instant the invoices count, so the statement and the invoices for
 *     one period count the same units.
 *   - Month buckets (`billing.gau_buckets`) that overlap the period, each with
 *     the ledger units behind its `used_gau`.
 *   - Settlements, reversals and prepaid orders created or paid in the period,
 *     each with the rate it charged and the invoice behind it.
 *   - Invoices (the Stripe mirror) created or paid in the period.
 *   - Usage credits (`billing.credit_ledger`): the opening balance, every
 *     addition and deduction by reason, and the closing balance.
 *   - Model usage from `cost.daily_totals`, reported and billed at zero.
 *
 * `export_billing_statement` renders the same statement as CSV (with every
 * ledger row) or printable HTML.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true` keeps the statement reachable at `remaining = 0`.
 *
 * Money on the wire is integer micro-units as a decimal string with an ISO
 * 4217 currency (INV-09). Usage credits are whole credits as a decimal string,
 * where one credit is one cent.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const STATEMENT_PERIOD_KINDS = [
  "week",
  "month",
  "quarter",
  "year",
  "custom",
] as const;
export type StatementPeriodKind = (typeof STATEMENT_PERIOD_KINDS)[number];

/** Breakdown rows reported before the rest fold into `other`. */
export const STATEMENT_TOP_DEFAULT = 25;
export const STATEMENT_TOP_MAX = 100;

/**
 * The period fields, shared by `get_billing_statement` and
 * `export_billing_statement`. A plain object so an MCP tool can spread its
 * shape. The rules across fields (an anchor for a calendar period, a range
 * for a custom one, longer than 48 hours and at most 366 days) are checked by
 * `resolveStatementPeriod` in `@oxagen/billing`, and a breach is
 * `invalid_input` naming the rule.
 */
export const statementPeriodInputShape = {
  period: z.enum(STATEMENT_PERIOD_KINDS),
  /** week, month, quarter, year: a UTC date inside the period. */
  anchor: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** custom: the first instant, RFC 3339. */
  from: z.string().datetime({ offset: true }).optional(),
  /** custom: the first instant after the period, RFC 3339. */
  to: z.string().datetime({ offset: true }).optional(),
};

/** Integer micro-units as a decimal string, never a float. */
const microsSchema = z.string().regex(/^-?\d+$/);
/** Whole usage credits (one credit is one cent) as a decimal string. */
const creditsSchema = z.string().regex(/^-?\d+$/);
const count = z.number().int().nonnegative();
const instant = z.string().datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const statementPeriodSchema = z
  .object({
    kind: z.enum(STATEMENT_PERIOD_KINDS),
    /** First instant, UTC. */
    start: instant,
    /** First instant after the period, UTC (half-open). */
    end: instant,
    /** The last UTC calendar day the period touches. */
    lastDay: day,
    /** "Q3 2026", "September 2026", "Week of 14 Sep 2026", "2026", "1 Sep 2026 to 9 Sep 2026". */
    label: z.string(),
  })
  .strict();

/** One attributed group. `key` is the raw id (null when unattributed), `label` its human name. */
export const statementGroupSchema = z
  .object({
    key: z.string().nullable(),
    label: z.string().nullable(),
    units: count,
    actions: count,
  })
  .strict();

/** What the rows past the top N add up to. */
export const statementOtherSchema = z
  .object({ groups: count, units: count, actions: count })
  .strict();

const breakdownSchema = z
  .object({
    rows: z.array(statementGroupSchema),
    other: statementOtherSchema,
  })
  .strict();

export const statementSubjectSchema = z
  .object({
    /** The capability, for a kernel action. */
    capability: z.string().nullable(),
    /** The tool, for a tool call. */
    toolName: z.string().nullable(),
    mcpServer: z.string().nullable(),
    units: count,
    actions: count,
  })
  .strict();

export const statementSourceSchema = z.enum([
  "kernel",
  "tacho",
  "external_tool",
]);

const governedActionsSchema = z
  .object({
    totalUnits: count,
    /** Ledger rows; one row is one billed governed action. */
    totalActions: count,
    bySource: z.array(
      z
        .object({ source: statementSourceSchema, units: count, actions: count })
        .strict(),
    ),
    byWorkspace: breakdownSchema,
    byAgent: breakdownSchema,
    byOperator: breakdownSchema,
    bySubject: z
      .object({
        rows: z.array(statementSubjectSchema),
        other: statementOtherSchema,
      })
      .strict(),
    /** Every UTC day the period touches, zeros included. */
    daily: z.array(
      z.object({ date: day, units: count, actions: count }).strict(),
    ),
  })
  .strict();

export const statementBucketSchema = z
  .object({
    periodStart: instant,
    periodEnd: instant,
    includedGau: count,
    purchasedGau: count,
    carriedGau: count,
    usedGau: count,
    overageInvoicedGau: count,
    /** included + purchased + carried - used. Negative when used ran past the total. */
    remainingGau: z.number().int(),
    /** max(0, -remainingGau). */
    overageGau: count,
    closedAt: instant.nullable(),
    /** Ledger units added to this bucket during the statement period. */
    unitsInPeriod: count,
    /** Every ledger unit ever added to this bucket. */
    ledgerUnits: count,
    /**
     * `matched`: ledgerUnits = usedGau. `unitemised`: usedGau is higher, by
     * units counted before the ledger existed. `mismatch`: the ledger holds
     * more than the bucket, which no writer should produce.
     */
    reconciliation: z.enum(["matched", "unitemised", "mismatch"]),
  })
  .strict();

export const statementInvoiceRefSchema = z
  .object({
    number: z.string().nullable(),
    status: z.string(),
    hostedInvoiceUrl: z.string().url().nullable(),
  })
  .strict();

export const statementSettlementSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["checkout", "auto_topup", "interim_invoice", "period_close"]),
    status: z.enum(["pending", "open", "paid", "failed"]),
    quantityGau: count,
    ratePerGauMicros: microsSchema,
    /** quantityGau x ratePerGauMicros: the subtotal before tax. */
    subtotalMicros: microsSchema,
    /** What Stripe charged, tax included; null when not recorded. */
    chargedMicros: microsSchema.nullable(),
    currency: z.string().length(3),
    createdAt: instant,
    settledAt: instant.nullable(),
    invoice: statementInvoiceRefSchema.nullable(),
  })
  .strict();

export const statementReversalSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["refund", "dispute"]),
    settlementId: z.string().uuid().nullable(),
    requestedGau: count,
    reversedGau: count,
    unrecoveredGau: count,
    amountMicros: microsSchema,
    currency: z.string().length(3),
    createdAt: instant,
  })
  .strict();

export const statementPrepaidOrderSchema = z
  .object({
    id: z.string().uuid(),
    status: z.enum(["open", "paid", "void", "uncollectible"]),
    agreementRef: z.string().nullable(),
    poNumber: z.string().nullable(),
    currency: z.string().length(3),
    licenceMicros: microsSchema,
    licencePeriodStart: instant.nullable(),
    licencePeriodEnd: instant.nullable(),
    gauQuantity: count,
    ratePerGauMicros: microsSchema,
    /** gauQuantity x ratePerGauMicros. */
    gauMicros: microsSchema,
    creditMicros: microsSchema,
    /** licence + units + credits. */
    totalMicros: microsSchema,
    createdAt: instant,
    paidAt: instant.nullable(),
    invoice: statementInvoiceRefSchema.nullable(),
  })
  .strict();

export const statementInvoiceSchema = z
  .object({
    publicId: z.string(),
    number: z.string().nullable(),
    status: z.enum(["open", "paid", "uncollectible", "void"]),
    kind: z.enum([
      "subscription",
      "gau_purchase",
      "gau_auto_topup",
      "gau_interim",
      "gau_period_close",
      "prepaid_order",
    ]),
    amountDueMicros: microsSchema,
    amountPaidMicros: microsSchema,
    amountRemainingMicros: microsSchema,
    currency: z.string().length(3),
    periodStart: instant,
    periodEnd: instant,
    issuedAt: instant,
    dueAt: instant.nullable(),
    paidAt: instant.nullable(),
    hostedInvoiceUrl: z.string().url().nullable(),
    invoicePdfUrl: z.string().url().nullable(),
  })
  .strict();

const creditMovementSchema = z
  .object({ reason: z.string(), credits: creditsSchema, entries: count })
  .strict();

const usageCreditsSchema = z
  .object({
    /** Ledger balance at the period's start. */
    openingCredits: creditsSchema,
    /** Positive ledger entries in the period, by reason. */
    additions: z.array(creditMovementSchema),
    /** Negative ledger entries in the period, by reason, as positive figures. */
    deductions: z.array(creditMovementSchema),
    /** Ledger balance at the period's end: opening + additions - deductions. */
    closingCredits: creditsSchema,
    /** The in-app assistant's model tokens on the platform key (consume_assistant_tokens). */
    assistantCredits: creditsSchema,
    /** Assistant deductions by the user the ledger entry names. */
    assistantByOperator: z.array(
      z
        .object({
          key: z.string(),
          label: z.string().nullable(),
          credits: creditsSchema,
          entries: count,
        })
        .strict(),
    ),
    /** Assistant deductions whose ledger entry names no user. */
    assistantUnattributedCredits: creditsSchema,
  })
  .strict();

const modelUsageSchema = z
  .object({
    rows: z.array(
      z
        .object({
          provider: z.string().nullable(),
          model: z.string(),
          calls: count,
          inputTokens: count,
          outputTokens: count,
          /** What the model vendor's price list puts on these calls; null when unpriced. */
          reportedCostMicros: microsSchema.nullable(),
          currency: z.string(),
        })
        .strict(),
    ),
    other: z
      .object({
        groups: count,
        calls: count,
        inputTokens: count,
        outputTokens: count,
      })
      .strict(),
    /** Always "0": Oxagen bills governed actions, not model tokens. */
    billedMicros: z.literal("0"),
  })
  .strict();

export const statementCheckSchema = z
  .object({
    id: z.string(),
    /** The identity, in words. */
    statement: z.string(),
    holds: z.boolean(),
  })
  .strict();

export const billingStatementSchema = z
  .object({
    version: z.literal(1),
    /** Deterministic: the same organization and period give the same reference. */
    reference: z.string(),
    generatedAt: instant,
    /** True while the period has not ended: the figures run to generatedAt. */
    provisional: z.boolean(),
    org: z
      .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
      .strict(),
    period: statementPeriodSchema,
    /** The terms in force at the period's end, or now for a provisional statement. */
    terms: z
      .object({
        source: z.enum(["negotiated", "published_tier"]),
        tier: z.string(),
        agreementRef: z.string().nullable(),
        currency: z.string().length(3),
        ratePerGauMicros: microsSchema,
        blockSizeGau: count,
        includedGauPerMonth: count,
        asOf: instant,
      })
      .strict(),
    /** Every negotiated agreement in force at some point in the period. */
    agreements: z.array(
      z
        .object({
          agreementRef: z.string(),
          currency: z.string().length(3),
          ratePerGauMicros: microsSchema,
          includedGauPerMonth: count,
          blockSizeGau: count,
          effectiveFrom: instant,
          effectiveTo: instant.nullable(),
        })
        .strict(),
    ),
    governedActions: governedActionsSchema,
    buckets: z.array(statementBucketSchema),
    settlements: z.array(statementSettlementSchema),
    reversals: z.array(statementReversalSchema),
    prepaidOrders: z.array(statementPrepaidOrderSchema),
    invoices: z.array(statementInvoiceSchema),
    invoiceTotals: z.array(
      z
        .object({
          currency: z.string().length(3),
          invoices: count,
          dueMicros: microsSchema,
          paidMicros: microsSchema,
          remainingMicros: microsSchema,
        })
        .strict(),
    ),
    usageCredits: usageCreditsSchema,
    modelUsage: modelUsageSchema,
    reconciliation: z.array(statementCheckSchema),
  })
  .strict();

export const billingStatementGet = registerCapability({
  name: "get_billing_statement",
  domain: "billing",
  description:
    "Get the organization's billing statement for a week, month, quarter, year or custom period longer than 48 hours: governed action units by source, workspace, agent, operator, capability and tool, and by day; the month buckets; settlements, reversals, prepaid orders and invoices; usage credits from opening to closing balance; model usage reported at zero; and the reconciliation checks the figures satisfy.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z
    .object({
      ...statementPeriodInputShape,
      /** Breakdown rows per dimension before the rest fold into `other`. */
      top: z
        .number()
        .int()
        .min(1)
        .max(STATEMENT_TOP_MAX)
        .default(STATEMENT_TOP_DEFAULT),
    })
    .strict(),
  output: billingStatementSchema,
});

export type BillingStatementGetInput = z.output<
  typeof billingStatementGet.input
>;
export type BillingStatement = z.output<typeof billingStatementSchema>;
export type StatementPeriod = z.output<typeof statementPeriodSchema>;
export type StatementGroup = z.output<typeof statementGroupSchema>;
export type StatementOther = z.output<typeof statementOtherSchema>;
export type StatementSubject = z.output<typeof statementSubjectSchema>;
export type StatementBucket = z.output<typeof statementBucketSchema>;
export type StatementSettlement = z.output<typeof statementSettlementSchema>;
export type StatementReversal = z.output<typeof statementReversalSchema>;
export type StatementPrepaidOrder = z.output<
  typeof statementPrepaidOrderSchema
>;
export type StatementInvoice = z.output<typeof statementInvoiceSchema>;
export type StatementInvoiceRef = z.output<typeof statementInvoiceRefSchema>;
export type StatementCheck = z.output<typeof statementCheckSchema>;
