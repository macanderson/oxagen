/**
 * `list_invoices`: the Invoices section of the Billing page
 * (apps/app/ARCHITECTURE.md §1.4, §3.9, WL-29). Reads the webhook-mirrored
 * `billing.invoices` header rows, newest first, keyset-paged on an opaque
 * cursor. Each row carries a `kind`: the settlement ledger
 * (`billing.gau_settlements`) names the Stripe Invoice behind every block
 * purchase, auto top-up, interim and period-close charge, and an invoice no
 * settlement names is the subscription's own.
 *
 * Drafts are excluded: Stripe finalizes a draft before it is collectable, and
 * the ledger's own draft (created with `auto_advance: false`) is never
 * presented to the customer until the recorder finalizes it.
 *
 * A console read is never a governed action (§1.5, ADR-052 exclusion 2):
 * `noBillingGate: true` keeps the page reachable at `remaining = 0` (INV-27).
 *
 * Money on the wire is integer micro-units as a decimal string with an ISO
 * 4217 currency (INV-09); the mirror stores cents, and the handler scales.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * What the invoice charged for. `subscription` is the plan's own invoice;
 * the four `gau_*` kinds map one-to-one onto `gau_settlements.kind`
 * (`checkout`, `auto_topup`, `interim_invoice`, `period_close`).
 */
export const invoiceKindSchema = z.enum([
  "subscription",
  "gau_purchase",
  "gau_auto_topup",
  "gau_interim",
  "gau_period_close",
]);

/** Stripe's own status as mirrored; `draft` is excluded from the list. */
export const invoiceStatusSchema = z.enum([
  "open",
  "paid",
  "uncollectible",
  "void",
]);

/** Integer micro-units as a decimal string, never a float. */
const microsSchema = z.string().regex(/^-?\d+$/);

export const invoiceItemSchema = z
  .object({
    publicId: z.string().describe("Prefixed public identifier (inv_)"),
    /** Stripe's invoice number; null when Stripe has not assigned one. */
    number: z.string().nullable(),
    status: invoiceStatusSchema,
    kind: invoiceKindSchema,
    amountDueMicros: microsSchema,
    amountPaidMicros: microsSchema,
    /** ISO 4217, lower case as Stripe reports it. */
    currency: z.string().length(3),
    /** RFC 3339. */
    periodStart: z.string().datetime(),
    /** RFC 3339. */
    periodEnd: z.string().datetime(),
    /**
     * The Stripe-hosted invoice page; null until Stripe publishes one. For an
     * `open` interim invoice of an org with no saved payment method, this is
     * how the org pays it.
     */
    hostedInvoiceUrl: z.string().url().nullable(),
  })
  .strict();

export const billingInvoiceList = registerCapability({
  name: "list_invoices",
  domain: "billing",
  description:
    "List the organization's invoices, newest first, in one cursor-paged list: number, status, what each invoice charged for (the subscription, a block purchase, an auto top-up, an interim or a period-close charge), amounts due and paid, period and the Stripe-hosted page.",
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
      items: z.array(invoiceItemSchema).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type BillingInvoiceListInput = z.output<typeof billingInvoiceList.input>;
export type BillingInvoiceListOutput = z.output<
  typeof billingInvoiceList.output
>;
export type InvoiceItem = z.output<typeof invoiceItemSchema>;
export type InvoiceKind = z.output<typeof invoiceKindSchema>;
