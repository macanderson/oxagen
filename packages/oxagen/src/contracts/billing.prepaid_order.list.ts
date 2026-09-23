/**
 * `list_prepaid_orders`: an organization's prepaid orders, newest first
 * (billing.prepaid_orders, ADR-158).
 *
 * A prepaid order is what an enterprise paid for in advance on one invoice:
 * the platform licence for a period, governed action units, and usage
 * credits for the in-app assistant. Each row carries its lines as the invoice
 * printed them, its status, when the units and the credits were granted, and
 * the invoice's number and hosted page from the webhook mirror
 * (`billing.invoices`, joined on `stripe_invoice_id`).
 *
 * An order still in `draft` is not listed: its invoice has not been sent, so
 * the customer has nothing to pay or to match it against.
 *
 * A console read, never a governed action: `noBillingGate: true` keeps it
 * reachable at `remaining = 0` (INV-27). Money on the wire is integer
 * micro-units as a decimal string with an ISO 4217 currency (INV-09).
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/** Integer micro-units as a decimal string, never a float. */
const microsSchema = z.string().regex(/^-?\d+$/);

/** One line of a prepaid order, as its invoice prints it. */
export const prepaidOrderLineSchema = z
  .object({
    kind: z.enum(["licence", "gau", "credits"]),
    description: z.string(),
    /** Units on the line: 1 for the licence and the credits, the unit count for GAUs. */
    quantity: z.number().int().min(1),
    amountMicros: microsSchema,
    /** RFC 3339, half-open `[start, end)`; null on a line with no service period. */
    periodStart: z.string().datetime().nullable(),
    periodEnd: z.string().datetime().nullable(),
  })
  .strict();

export const prepaidOrderStatusSchema = z.enum([
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
]);

export const prepaidOrderItemSchema = z
  .object({
    orderId: z.string().uuid(),
    /** Listed orders are never `draft`. */
    status: prepaidOrderStatusSchema.exclude(["draft"]),
    agreementRef: z.string().nullable(),
    poNumber: z.string().nullable(),
    /** ISO 4217, lower case. */
    currency: z.string().length(3),
    lines: z.array(prepaidOrderLineSchema).max(3),
    totalMicros: microsSchema,
    /** `paid`: granted on payment. `issue`: granted when the invoice was sent. */
    grantOn: z.enum(["paid", "issue"]),
    /** RFC 3339; null until the units are in the org's bucket. */
    unitsGrantedAt: z.string().datetime().nullable(),
    /** RFC 3339; null until the credits are in the org's balance. */
    creditsGrantedAt: z.string().datetime().nullable(),
    paidAt: z.string().datetime().nullable(),
    /** RFC 3339: when the order was written. */
    createdAt: z.string().datetime(),
    /** The invoice as the webhook mirror holds it; null until the mirror has it. */
    invoice: z
      .object({
        number: z.string().nullable(),
        status: prepaidOrderStatusSchema,
        dueAt: z.string().datetime().nullable(),
        hostedInvoiceUrl: z.string().url().nullable(),
        invoicePdfUrl: z.string().url().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const billingPrepaidOrderList = registerCapability({
  name: "list_prepaid_orders",
  domain: "billing",
  description:
    "List the organization's prepaid orders, newest first: the licence, governed action units and usage credits each invoice sold, with amounts, the service period, status, when the units and credits were granted, and the invoice number and hosted page.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      limit: z.number().int().min(1).max(100).default(50),
      /** Opaque; only a cursor this capability returned is accepted. */
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(prepaidOrderItemSchema).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type BillingPrepaidOrderListInput = z.output<
  typeof billingPrepaidOrderList.input
>;
export type BillingPrepaidOrderListOutput = z.output<
  typeof billingPrepaidOrderList.output
>;
export type PrepaidOrderItem = z.output<typeof prepaidOrderItemSchema>;
export type PrepaidOrderLine = z.output<typeof prepaidOrderLineSchema>;
