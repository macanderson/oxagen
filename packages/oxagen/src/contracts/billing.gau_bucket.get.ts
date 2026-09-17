/**
 * `get_gau_bucket`: the Billing mode, Governed action bucket and Auto top-up
 * sections of the Billing page (apps/app/ARCHITECTURE.md §1.4, §3.9, WL-27).
 *
 * One month of governed action units for the organisation: which billing mode
 * it is on, the month the bucket covers, the four counts the balance is made
 * of and the balance itself, plus the half of the picture its mode owns —
 * invoice thresholds for an organisation approved for invoice billing, auto
 * top-up state for a prepaid one.
 *
 * The output is counts, dates, booleans and short strings. No money crosses
 * this wire: the contracted rate and the block price are `get_contract_rate`'s
 * and the amounts are `list_invoices`', so two readers of one figure on one
 * page cannot disagree (INV-09, INV-25). `blockSizeGau` is on the rate block
 * for the same reason, and the credit balance and the meter mode the retired
 * `get_action_usage` reported have no successor here.
 *
 * `invoice` is non-null exactly in invoice mode and `autoTopup` exactly in
 * prepaid, checked by the output schema itself rather than by a reader: an
 * organisation's `invoice_gau_max` is stored whatever its mode, and a page
 * that printed a cap for a prepaid organisation would print a number with no
 * effect anywhere (ADR-055 §5).
 *
 * A console read is never a governed action (§1.5, ADR-052 exclusion 2):
 * `noBillingGate: true` keeps the page reachable at `remaining ≤ 0` (INV-27).
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Which side of ADR-055 §5 the organisation is on. */
const gauBillingModeSchema = z.enum(["prepaid", "invoice"]);

/** A count of governed action units. Never negative on its own. */
const gauCount = z.number().int().nonnegative();

/** The half-open month the bucket covers, `[start, end)`, RFC 3339. */
const gauPeriodSchema = z
  .object({
    start: z.string().datetime(),
    end: z.string().datetime(),
  })
  .strict();

/**
 * Invoice billing only. `gauMax` is the cap at which an interim invoice is
 * cut, `uninvoicedGau` the overage accrued since the last one, and
 * `invoicedThisPeriodGau` what interim and period-close settlements of this
 * month have already claimed. `pastDue` is true while one of those invoices
 * is finalized and unpaid; the organisation keeps running (ADR-055 §5).
 */
const gauInvoiceSchema = z
  .object({
    gauMax: z.number().int().positive(),
    uninvoicedGau: gauCount,
    invoicedThisPeriodGau: gauCount,
    pastDue: z.boolean(),
  })
  .strict();

/**
 * The card an auto top-up charges, as the page prints it: "charged to
 * <brand> ····<last4>". Null when the organisation has saved none — then auto
 * top-up cannot run and the gate refuses at exhaustion (ADR-055 §6).
 */
const gauPaymentMethodSchema = z
  .object({
    brand: z.string().nullable(),
    last4: z.string().nullable(),
  })
  .strict();

/** The latest auto top-up episode of the month and how it ended. */
const gauLastAttemptSchema = z
  .object({
    at: z.string().datetime(),
    status: z.enum(["paid", "open", "failed"]),
  })
  .strict();

/** Prepaid only. */
const gauAutoTopupSchema = z
  .object({
    enabled: z.boolean(),
    blocks: z.number().int().positive(),
    paymentMethod: gauPaymentMethodSchema.nullable(),
    lastAttempt: gauLastAttemptSchema.nullable(),
  })
  .strict();

const gauBucketOutputSchema = z
  .object({
    mode: gauBillingModeSchema,
    period: gauPeriodSchema,
    includedGau: gauCount,
    purchasedGau: gauCount,
    carriedGau: gauCount,
    usedGau: gauCount,
    /**
     * `included + purchased + carried − used`. Negative when overdrawn: the
     * gate checks `remaining > 0` before the handler and the recorder debits
     * after it, so concurrent governed actions can drive `used` past the
     * total. The figure is reported as stored, never clamped, and the page
     * prints "overdrawn by N" (ADR-055 §4).
     */
    remainingGau: z.number().int(),
    invoice: gauInvoiceSchema.nullable(),
    autoTopup: gauAutoTopupSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // The mode decides which half is present. Enforced here so no reader has
    // to, and so a handler that answered with both (or neither) fails at the
    // kernel's output parse rather than on the page.
    const wantsInvoice = value.mode === "invoice";
    if (wantsInvoice !== (value.invoice !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["invoice"],
        message: "invoice is non-null exactly when mode is 'invoice'",
      });
    }
    if (wantsInvoice === (value.autoTopup !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["autoTopup"],
        message: "autoTopup is non-null exactly when mode is 'prepaid'",
      });
    }
  });

export const billingGauBucketGet = registerCapability({
  name: "get_gau_bucket",
  domain: "billing",
  description:
    "Read the organization's governed action unit bucket for the current month: the billing mode, the period, the units included, purchased, carried forward, used and remaining, plus the invoice thresholds of an invoice-billed organization or the auto top-up state of a prepaid one.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow" },
    workspace: {},
  },
  input: z.object({}).strict(),
  output: gauBucketOutputSchema,
});

export type BillingGauBucketGetInput = z.output<
  typeof billingGauBucketGet.input
>;
export type BillingGauBucketGetOutput = z.output<
  typeof billingGauBucketGet.output
>;
