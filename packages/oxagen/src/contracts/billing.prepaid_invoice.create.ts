/**
 * `create_prepaid_invoice`: the platform operator issues an enterprise's
 * prepaid order and its Stripe invoice (billing.prepaid_orders, ADR-165).
 *
 * One order carries up to three lines, each optional but at least one:
 *   - `licence`: the platform licence for a period, printed with the
 *     agreement and the period on the line;
 *   - `gau`: governed action units at the contracted rate (the org's
 *     negotiated `contract_terms` rate unless one is given), added to the
 *     org's bucket as purchased units that carry into later months;
 *   - `creditsCents`: usage credits for the in-app assistant, 1 credit =
 *     1 cent, granted as a lot that never expires.
 *
 * The handler writes the `draft` order row first, then creates the invoice
 * (`send_invoice`, due in `daysUntilDue` days, "Agreement" and "PO number"
 * printed in the header), checks its subtotal against the order, sends it,
 * and marks the order `open`. The units and credits are granted when the
 * invoice is paid, or at once for `grantOn: "issue"`.
 *
 * `orderId` is the resume key. Leave it out and the handler mints one and
 * returns it; pass it back with the same lines to resume an order a failure
 * interrupted. A resume never creates a second invoice. The same id with
 * different lines is refused as a conflict.
 *
 * `assistantSpendCapCents` sets the org's monthly cap on platform-paid
 * assistant tokens when the credits are granted (null removes the cap).
 * Left out, the cap stays as it is; the operator script warns when the
 * order's credits exceed it.
 *
 * Platform-operator only (`platformOnly`, `surfaces: []`, no role grants it;
 * INV-31). The one caller is `tools/scripts/billing-prepaid-invoice.ts`
 * (`pnpm billing:prepaid-invoice`).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  prepaidOrderLineSchema,
  prepaidOrderStatusSchema,
} from "./billing.prepaid_order.list";

const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().datetime({ offset: true });
/** Integer micro-units as a decimal string, never a float. */
const microsSchema = z
  .string()
  .regex(/^\d{1,15}$/, "a whole number of micro-units");
const headerField = z.string().trim().min(1).max(140);

export const billingPrepaidInvoiceCreate = registerCapability({
  name: "create_prepaid_invoice",
  domain: "billing",
  description:
    "Platform-operator only: issue an enterprise's prepaid order (a platform licence for a period, governed action units, usage credits) on a Stripe invoice sent for payment by transfer, and grant the units and credits when it is paid.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "unit", "docs"],
  scoped: false,
  platformOnly: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: {}, workspace: {} },
  input: z
    .object({
      orgId: z.string().uuid(),
      /** Resume key; minted by the handler when left out. */
      orderId: z.string().uuid().optional(),
      /** Defaults to the org's negotiated agreement, when it has one. */
      agreementRef: headerField.optional(),
      poNumber: headerField.optional(),
      /** ISO 4217, lower case. Defaults to the org's contract currency. */
      currency: z
        .string()
        .regex(/^[a-z]{3}$/)
        .optional(),
      licence: z
        .object({
          amountCents: cents.min(1),
          /** RFC 3339, half-open: the licence runs from periodStart until periodEnd. */
          periodStart: instant,
          periodEnd: instant,
        })
        .strict()
        .optional(),
      gau: z
        .object({
          quantity: cents.min(1),
          /** Defaults to the org's negotiated rate; required when it has none. */
          ratePerGauMicros: microsSchema.optional(),
        })
        .strict()
        .optional(),
      creditsCents: cents.optional(),
      daysUntilDue: z.number().int().min(0).max(365).default(30),
      grantOn: z.enum(["paid", "issue"]).default("paid"),
      /** Printed above the lines. */
      memo: z.string().trim().min(1).max(500).optional(),
      /** Monthly cap on platform-paid assistant tokens, set at the credits grant; null removes it. */
      assistantSpendCapCents: cents.nullable().optional(),
    })
    .strict(),
  output: z
    .object({
      orderId: z.string().uuid(),
      orgId: z.string().uuid(),
      /** True when the order already existed and this call resumed it. */
      resumed: z.boolean(),
      status: prepaidOrderStatusSchema,
      agreementRef: z.string().nullable(),
      poNumber: z.string().nullable(),
      currency: z.string().length(3),
      lines: z.array(prepaidOrderLineSchema).max(3),
      totalMicros: microsSchema,
      stripeInvoiceId: z.string().nullable(),
      invoiceNumber: z.string().nullable(),
      hostedInvoiceUrl: z.string().url().nullable(),
      invoicePdfUrl: z.string().url().nullable(),
      /** The issue-time grant; null when the order grants on payment. */
      grant: z
        .object({
          unitsGranted: z.number().int().min(0),
          creditsGrantedCents: z.number().int().min(0),
          /** The cap this grant wrote; absent when it wrote none. */
          assistantSpendCapCents: z.number().int().nullable().optional(),
        })
        .strict()
        .nullable(),
    })
    .strict(),
});

export type BillingPrepaidInvoiceCreateInput = z.output<
  typeof billingPrepaidInvoiceCreate.input
>;
export type BillingPrepaidInvoiceCreateOutput = z.output<
  typeof billingPrepaidInvoiceCreate.output
>;
