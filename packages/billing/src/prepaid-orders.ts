/**
 * prepaid-orders.ts: an enterprise order paid in advance on a Stripe invoice
 * (billing.prepaid_orders, ADR-165).
 *
 * One order carries up to three lines: the platform licence for a period,
 * prepaid governed action units, and prepaid usage credits for the in-app
 * assistant. The life of an order:
 *
 *   1. openPrepaidOrder writes the `draft` row FIRST, keyed on an id the
 *      caller chooses, so a re-run of the same order finds its row.
 *   2. invoicePrepaidOrder creates the Stripe invoice (every request keyed on
 *      the order id), records `stripe_invoice_id`, checks the draft's subtotal
 *      against the order, sends it, and marks the row `open`. A row that
 *      already holds an invoice id skips the create, so a resume never makes a
 *      second invoice.
 *   3. grantPrepaidOrder adds the units to the current bucket's purchased_gau
 *      and grants the credits as a lot, under an advisory lock on the order,
 *      each fenced by its own `*_granted_at` column. It runs on invoice.paid,
 *      or at issue for an order marked `grant_on = 'issue'`.
 *   4. closePrepaidOrder mirrors invoice.voided and marked_uncollectible onto
 *      the row. A grant already made is recorded, never clawed back.
 *
 * The prepaid credits never expire. grants.ts gives a self-serve credit pack a
 * one-year expiry; a prepaid order is a contract, and its expiry, if any, is a
 * term of that contract. The table has no column for one, so an expiry here
 * would destroy money the customer paid for on a date nobody agreed.
 *
 * The order's assistant cap instruction lives on the invoice metadata
 * (`assistant_spend_cap_cents`), not on the row: the table has no column for
 * it. It is applied in the transaction that grants the credits, once.
 */

// tenancy: system bypass via withSystemDb throughout. The callers are the
// create_prepaid_invoice handler (unscoped, platformOnly, keyed on its input's
// orgId) and the Stripe webhook (the order id comes from the invoice
// metadata). Neither runs inside a tenant scope.

import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Tx, withSystemDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { writeAssistantSpendCapOn } from "./billing-settings";
import { billingProvider } from "./client";
import { CREDIT_REASONS } from "./constants";
import { readGauEntitlement } from "./contract-terms";
import { ensureStripeCustomer } from "./customers";
import { ensureCurrentBucket, periodFor } from "./gau-bucket";
import { grantCreditLotOnce } from "./grants";
import {
  formatCount,
  formatMoney,
  formatPeriod,
  formatRatePerThousand,
} from "./invoice-copy";
import { logger } from "./logger";
import type {
  AssistantSpendCapChange,
  BillingPrepaidInvoiceLine,
  BillingPrepaidInvoiceState,
} from "./provider";

export type PrepaidOrderRow = typeof schema.prepaidOrders.$inferSelect;

/** The footer every prepaid invoice carries. */
export const PREPAID_INVOICE_FOOTER =
  "Itemised usage: request a statement for any period from Billing → Statements.";

/** `credit_ledger.reference_type` of a prepaid order's credits grant. */
const PREPAID_REFERENCE_TYPE = "prepaid_order";

// ── Errors ──────────────────────────────────────────────────────────────────

export type PrepaidOrderErrorCode =
  /** The order breaks a rule of the table or of the invoice it becomes. */
  | "invalid_prepaid_order"
  /** An order id already names a different order, or a different invoice. */
  | "prepaid_order_conflict"
  | "prepaid_order_not_found"
  /** The order's invoice is void or uncollectible, or not yet issued. */
  | "prepaid_order_closed";

export class PrepaidOrderError extends Error {
  constructor(
    readonly code: PrepaidOrderErrorCode,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PrepaidOrderError";
  }
}

// ── The order as the operator states it ─────────────────────────────────────

export interface PrepaidOrderSpec {
  orgId: string;
  agreementRef: string | null;
  poNumber: string | null;
  /** ISO 4217, lower case. */
  currency: string;
  /** The licence line; its period is half-open `[start, end)`. */
  licence: { amountCents: number; periodStart: Date; periodEnd: Date } | null;
  /** Prepaid units at a per-GAU rate in micro-units of the currency. */
  gau: { quantity: number; ratePerGauMicros: bigint } | null;
  /** Usage credits, 1 credit = 1 cent; 0 for none. */
  creditCents: number;
  daysUntilDue: number;
  grantOn: "paid" | "issue";
  memo: string | null;
  assistantSpendCap: AssistantSpendCapChange;
}

/** The fields the invoice lines are made of. A stored row satisfies it. */
export type PrepaidOrderFigures = Pick<
  PrepaidOrderRow,
  | "agreementRef"
  | "currency"
  | "licenceCents"
  | "licencePeriodStart"
  | "licencePeriodEnd"
  | "gauQuantity"
  | "ratePerGauMicros"
  | "creditCents"
>;

function refuse(reason: string, message: string): never {
  throw new PrepaidOrderError("invalid_prepaid_order", reason, message);
}

function isWholeAmount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * Refuse an order the table's CHECKs would refuse, and the ones the invoice
 * cannot carry, before anything is written. The table's rules: every amount
 * non-negative, at least one line, `gau_quantity × rate` a whole number of
 * cents, `days_until_due` 0 to 365, a licence line with a period and a period
 * with a licence line.
 */
export function assertPrepaidOrder(spec: PrepaidOrderSpec): void {
  if (!/^[a-z]{3}$/.test(spec.currency)) {
    refuse(
      "currency",
      `The currency must be an ISO 4217 code in lower case; got "${spec.currency}".`,
    );
  }
  for (const [field, value] of [
    ["agreement reference", spec.agreementRef],
    ["PO number", spec.poNumber],
  ] as const) {
    // Stripe prints each as an invoice custom field, 140 characters at most.
    if (value !== null && (value.trim() === "" || value.length > 140)) {
      refuse("header_field", `The ${field} must be 1 to 140 characters.`);
    }
  }
  if (spec.memo !== null && spec.memo.length > 500) {
    refuse("memo", "The memo must be 500 characters or fewer.");
  }
  if (spec.licence) {
    const { amountCents, periodStart, periodEnd } = spec.licence;
    if (!isWholeAmount(amountCents) || amountCents === 0) {
      refuse(
        "licence_amount",
        "The licence amount must be a whole number of cents above zero.",
      );
    }
    if (
      Number.isNaN(periodStart.getTime()) ||
      Number.isNaN(periodEnd.getTime()) ||
      periodEnd <= periodStart
    ) {
      refuse("licence_period", "The licence period must end after it starts.");
    }
  }
  if (spec.gau) {
    const { quantity, ratePerGauMicros } = spec.gau;
    if (!isWholeAmount(quantity) || quantity === 0) {
      refuse(
        "gau_quantity",
        "The prepaid units must be a whole number above zero.",
      );
    }
    if (ratePerGauMicros < 0n) {
      refuse(
        "gau_rate",
        "The rate per governed action unit cannot be negative.",
      );
    }
    const micros = BigInt(quantity) * ratePerGauMicros;
    if (micros % 10_000n !== 0n) {
      refuse(
        "gau_not_whole_cents",
        `${formatCount(quantity)} units at ${ratePerGauMicros} micros each come to ${micros} micros, which is not a whole number of cents. Change the quantity or the rate.`,
      );
    }
  }
  if (!isWholeAmount(spec.creditCents)) {
    refuse(
      "credit_amount",
      "The credits must be a whole number of cents, 0 or more.",
    );
  }
  if (!spec.licence && !spec.gau && spec.creditCents === 0) {
    refuse(
      "empty_order",
      "The order has no line: add a licence, units, or credits.",
    );
  }
  if (
    !Number.isInteger(spec.daysUntilDue) ||
    spec.daysUntilDue < 0 ||
    spec.daysUntilDue > 365
  ) {
    refuse(
      "days_until_due",
      "Days until due must be a whole number from 0 to 365.",
    );
  }
  if (spec.assistantSpendCap.kind === "set") {
    const cap = spec.assistantSpendCap.capCents;
    if (spec.creditCents === 0) {
      refuse(
        "cap_without_credits",
        "An assistant cap rides an order that carries credits. Set it on its own with pnpm billing:terms --assistant-cap-usd.",
      );
    }
    if (cap !== null && !isWholeAmount(cap)) {
      refuse(
        "assistant_cap",
        "The assistant cap must be a whole number of cents, 0 or more, or none.",
      );
    }
  }
}

// ── The invoice lines ───────────────────────────────────────────────────────

/** One line of the order, with what it comes to. */
export interface PrepaidOrderLine extends BillingPrepaidInvoiceLine {
  amountCents: number;
}

/** Micro-units per unit as Stripe's `unit_amount_decimal` in cents. */
function centsDecimalOfMicros(micros: bigint): string {
  const whole = micros / 10_000n;
  const fraction = (micros % 10_000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * The order's invoice lines, in the order they print:
 *
 *   Oxagen platform licence (agreement MSA-2026-014): 1 Oct 2026 to 30 Sep 2027
 *   Governed action units, prepaid: 2,000,000 GAU at $3.00 per 1,000
 *   Usage credits for the in-app assistant, prepaid: $5,000.00 (500,000 credits)
 *
 * The licence line carries its period, which Stripe prints on the line.
 */
export function prepaidOrderLines(
  order: PrepaidOrderFigures,
): PrepaidOrderLine[] {
  const lines: PrepaidOrderLine[] = [];
  const licenceCents = Number(order.licenceCents);
  if (licenceCents > 0 && order.licencePeriodStart && order.licencePeriodEnd) {
    const period = {
      start: order.licencePeriodStart,
      end: order.licencePeriodEnd,
    };
    const label = order.agreementRef
      ? `Oxagen platform licence (agreement ${order.agreementRef})`
      : "Oxagen platform licence";
    lines.push({
      key: "licence",
      description: `${label}: ${formatPeriod(period)}`,
      quantity: 1,
      unitAmountDecimal: String(licenceCents),
      amountCents: licenceCents,
      period,
    });
  }
  const gau = Number(order.gauQuantity);
  if (gau > 0) {
    const rate = BigInt(order.ratePerGauMicros);
    lines.push({
      key: "gau",
      description: `Governed action units, prepaid: ${formatCount(gau)} GAU at ${formatRatePerThousand(rate, order.currency)}`,
      quantity: gau,
      unitAmountDecimal: centsDecimalOfMicros(rate),
      amountCents: Number((BigInt(gau) * rate) / 10_000n),
      period: null,
    });
  }
  const credits = Number(order.creditCents);
  if (credits > 0) {
    lines.push({
      key: "credits",
      description: `Usage credits for the in-app assistant, prepaid: ${formatMoney(credits, order.currency)} (${formatCount(credits)} credits)`,
      quantity: 1,
      unitAmountDecimal: String(credits),
      amountCents: credits,
      period: null,
    });
  }
  return lines;
}

/** What the order comes to, in minor units: the invoice's subtotal. */
export function prepaidOrderTotalCents(order: PrepaidOrderFigures): number {
  return prepaidOrderLines(order).reduce(
    (sum, line) => sum + line.amountCents,
    0,
  );
}

/** The invoice header fields: the agreement and the PO number, when present. */
function prepaidInvoiceCustomFields(
  order: Pick<PrepaidOrderRow, "agreementRef" | "poNumber">,
): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  if (order.agreementRef)
    fields.push({ name: "Agreement", value: order.agreementRef });
  if (order.poNumber) fields.push({ name: "PO number", value: order.poNumber });
  return fields;
}

/** The cap instruction as invoice metadata: absent, `none`, or digits. */
function assistantCapMetadata(
  cap: AssistantSpendCapChange,
): Record<string, string> {
  if (cap.kind === "unchanged") return {};
  return {
    assistant_spend_cap_cents:
      cap.capCents === null ? "none" : String(cap.capCents),
  };
}

// ── The defaults an order takes from the org's agreement ────────────────────

/** What an order defaults to when the operator leaves a field out. */
export interface PrepaidOrderDefaults {
  /** The currency the org's terms are in. */
  currency: string;
  /** The negotiated agreement; null when the org is on published terms. */
  agreementRef: string | null;
  /** The negotiated rate; null when the org is on published terms. */
  ratePerGauMicros: bigint | null;
}

/**
 * The org's terms in force at `now`, as an order's defaults. Only a
 * negotiated agreement supplies a rate or an agreement reference: a prepaid
 * order sells units at a contracted rate, and a published tier's rate is not
 * one anybody signed.
 */
export async function readPrepaidOrderDefaults(
  orgId: string,
  now: Date = new Date(),
): Promise<PrepaidOrderDefaults> {
  // tenancy: platform-operator read with no tenant scope, filtered by orgId from
  // the input of create_prepaid_invoice, whose binding the kernel verified.
  const { terms } = await withSystemDb((tx) =>
    readGauEntitlement(tx, orgId, now),
  );
  return terms.source === "negotiated"
    ? {
        currency: terms.currency,
        agreementRef: terms.agreementRef,
        ratePerGauMicros: terms.ratePerGauMicros,
      }
    : { currency: terms.currency, agreementRef: null, ratePerGauMicros: null };
}

/**
 * An order as the operator asks for it: every field the agreement can supply
 * may be left out. `create_prepaid_invoice` and the operator script's dry run
 * both resolve one through {@link resolvePrepaidOrderSpec}, so the dry run
 * prints the order the handler will write.
 */
export interface PrepaidOrderRequest {
  orgId: string;
  agreementRef?: string;
  poNumber?: string;
  currency?: string;
  licence?: { amountCents: number; periodStart: Date; periodEnd: Date };
  gau?: { quantity: number; ratePerGauMicros?: bigint };
  creditsCents?: number;
  daysUntilDue: number;
  grantOn: "paid" | "issue";
  memo?: string;
  /** Left out: the cap stays as it is. Null: no cap. */
  assistantSpendCapCents?: number | null;
}

/**
 * The order a request describes, with the agreement's defaults filled in.
 * Units need a rate: the request's, or the negotiated one when the order is
 * in the agreement's currency. Refuses with `gau_rate_required` otherwise.
 */
export function resolvePrepaidOrderSpec(
  req: PrepaidOrderRequest,
  defaults: PrepaidOrderDefaults,
): PrepaidOrderSpec {
  const currency = req.currency ?? defaults.currency;
  let gau: PrepaidOrderSpec["gau"] = null;
  if (req.gau) {
    let rate = req.gau.ratePerGauMicros;
    if (rate === undefined) {
      if (defaults.ratePerGauMicros === null) {
        refuse(
          "gau_rate_required",
          "The org has no negotiated terms, so there is no contracted rate to sell units at. Set its contract terms first, or give the rate.",
        );
      }
      if (currency !== defaults.currency) {
        refuse(
          "gau_rate_required",
          `The contracted rate is in ${defaults.currency} and the order is in ${currency}. Give the rate in ${currency}.`,
        );
      }
      rate = defaults.ratePerGauMicros;
    }
    gau = { quantity: req.gau.quantity, ratePerGauMicros: rate };
  }
  return {
    orgId: req.orgId,
    agreementRef: req.agreementRef ?? defaults.agreementRef,
    poNumber: req.poNumber ?? null,
    currency,
    licence: req.licence ?? null,
    gau,
    creditCents: req.creditsCents ?? 0,
    daysUntilDue: req.daysUntilDue,
    grantOn: req.grantOn,
    memo: req.memo ?? null,
    assistantSpendCap:
      req.assistantSpendCapCents === undefined
        ? { kind: "unchanged" }
        : { kind: "set", capCents: req.assistantSpendCapCents },
  };
}

// ── 1. The draft row ────────────────────────────────────────────────────────

function rowValues(spec: PrepaidOrderSpec) {
  return {
    orgId: spec.orgId,
    agreementRef: spec.agreementRef,
    poNumber: spec.poNumber,
    currency: spec.currency,
    licenceCents: spec.licence?.amountCents ?? 0,
    licencePeriodStart: spec.licence?.periodStart ?? null,
    licencePeriodEnd: spec.licence?.periodEnd ?? null,
    gauQuantity: spec.gau?.quantity ?? 0,
    ratePerGauMicros: spec.gau?.ratePerGauMicros ?? 0n,
    creditCents: spec.creditCents,
    grantOn: spec.grantOn,
    daysUntilDue: spec.daysUntilDue,
    memo: spec.memo,
  };
}

/**
 * The figures an order's lines are made of, from the order as stated: what
 * the dry run of `pnpm billing:prepaid-invoice` prints the lines from, before
 * any row exists.
 */
export function prepaidOrderFigures(
  spec: PrepaidOrderSpec,
): PrepaidOrderFigures {
  const v = rowValues(spec);
  return {
    agreementRef: v.agreementRef,
    currency: v.currency,
    licenceCents: v.licenceCents,
    licencePeriodStart: v.licencePeriodStart,
    licencePeriodEnd: v.licencePeriodEnd,
    gauQuantity: v.gauQuantity,
    ratePerGauMicros: v.ratePerGauMicros,
    creditCents: v.creditCents,
  };
}

const time = (d: Date | null): number | null =>
  d === null ? null : d.getTime();

/** Whether a stored row is the order `spec` describes. */
function sameOrder(row: PrepaidOrderRow, spec: PrepaidOrderSpec): boolean {
  const v = rowValues(spec);
  return (
    row.orgId === v.orgId &&
    row.agreementRef === v.agreementRef &&
    row.poNumber === v.poNumber &&
    row.currency === v.currency &&
    Number(row.licenceCents) === v.licenceCents &&
    time(row.licencePeriodStart) === time(v.licencePeriodStart) &&
    time(row.licencePeriodEnd) === time(v.licencePeriodEnd) &&
    Number(row.gauQuantity) === v.gauQuantity &&
    BigInt(row.ratePerGauMicros) === v.ratePerGauMicros &&
    Number(row.creditCents) === v.creditCents &&
    row.grantOn === v.grantOn &&
    row.daysUntilDue === v.daysUntilDue &&
    row.memo === v.memo
  );
}

async function readOrder(
  tx: Tx,
  orderId: string,
): Promise<PrepaidOrderRow | null> {
  const rows = await tx
    .select()
    .from(schema.prepaidOrders)
    .where(eq(schema.prepaidOrders.id, orderId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Write the order's `draft` row, or find it. The insert is
 * `ON CONFLICT (id) DO NOTHING`, so a re-run with the same id inserts
 * nothing; the row it finds must be the same order, or the id is refused as
 * naming a different one.
 */
export async function openPrepaidOrder(args: {
  id: string;
  spec: PrepaidOrderSpec;
  issuedByRequestId: string | null;
}): Promise<{ order: PrepaidOrderRow; created: boolean }> {
  assertPrepaidOrder(args.spec);
  // tenancy: platform-operator write with no tenant scope; the row is keyed on
  // orgId from the input of create_prepaid_invoice, whose binding the kernel verified.
  return withSystemDb(async (tx) => {
    const inserted = await tx
      .insert(schema.prepaidOrders)
      .values({
        id: args.id,
        ...rowValues(args.spec),
        status: "draft",
        issuedByRequestId: args.issuedByRequestId,
      })
      .onConflictDoNothing({ target: schema.prepaidOrders.id })
      .returning();
    if (inserted[0]) return { order: inserted[0], created: true };
    const existing = await readOrder(tx, args.id);
    if (!existing) {
      throw new Error(
        `billing: prepaid order ${args.id} neither inserted nor found`,
      );
    }
    if (!sameOrder(existing, args.spec)) {
      throw new PrepaidOrderError(
        "prepaid_order_conflict",
        "order_id_reused",
        `Order ${args.id} already exists with different lines. Resume it with the flags it was issued with, or leave out the order id to issue a new order.`,
      );
    }
    return { order: existing, created: false };
  });
}

// ── 2. The invoice ──────────────────────────────────────────────────────────

/** Record the invoice id on a row that holds none, or confirm it holds this one. */
async function recordPrepaidInvoice(
  orderId: string,
  invoiceId: string,
): Promise<void> {
  // tenancy: platform-operator write with no tenant scope, filtered by the order
  // id the caller verified belongs to the orgId it was issued for.
  await withSystemDb(async (tx) => {
    const updated = await tx
      .update(schema.prepaidOrders)
      .set({ stripeInvoiceId: invoiceId, updatedAt: new Date() })
      .where(
        and(
          eq(schema.prepaidOrders.id, orderId),
          isNull(schema.prepaidOrders.stripeInvoiceId),
        ),
      )
      .returning({ id: schema.prepaidOrders.id });
    if (updated.length > 0) return;
    const row = await readOrder(tx, orderId);
    if (row?.stripeInvoiceId !== invoiceId) {
      throw new PrepaidOrderError(
        "prepaid_order_conflict",
        "second_invoice",
        `Order ${orderId} already records invoice ${row?.stripeInvoiceId ?? "(none)"}, not ${invoiceId}.`,
      );
    }
  });
}

export interface PrepaidInvoiceOutcome {
  order: PrepaidOrderRow;
  invoice: BillingPrepaidInvoiceState;
  /** The issue-time grant (`grant_on = 'issue'`, or an invoice Stripe settled on send); null when none ran. */
  grant: PrepaidGrantResult | null;
}

/**
 * Create, record and send the order's invoice, then grant at issue when the
 * order says so. Safe to re-run: a row holding an invoice id skips the
 * create, `sendPrepaidInvoice` only reads an invoice that is already open,
 * and the grant is fenced. A failure leaves the row where it stopped, for the
 * next run to resume.
 */
export async function invoicePrepaidOrder(
  orderId: string,
  opts: { assistantSpendCap: AssistantSpendCapChange; now?: Date },
): Promise<PrepaidInvoiceOutcome> {
  // tenancy: platform-operator read with no tenant scope, filtered by the order id
  // that openPrepaidOrder wrote for the verified orgId.
  const order = await withSystemDb((tx) => readOrder(tx, orderId));
  if (!order) {
    throw new PrepaidOrderError(
      "prepaid_order_not_found",
      "no_order",
      `No prepaid order ${orderId}.`,
    );
  }
  if (order.status === "void" || order.status === "uncollectible") {
    throw new PrepaidOrderError(
      "prepaid_order_closed",
      order.status,
      `Order ${orderId}'s invoice is ${order.status}. Issue a new order instead.`,
    );
  }

  const lines = prepaidOrderLines(order);
  const provider = billingProvider();
  let invoiceId = order.stripeInvoiceId;
  if (invoiceId === null) {
    const customerId = await ensureStripeCustomer(order.orgId, {
      system: true,
    });
    const created = await provider.createPrepaidInvoice({
      customerId,
      orgId: order.orgId,
      orderId,
      currency: order.currency,
      daysUntilDue: order.daysUntilDue,
      lines: lines.map((line) => ({
        key: line.key,
        description: line.description,
        quantity: line.quantity,
        unitAmountDecimal: line.unitAmountDecimal,
        period: line.period,
      })),
      customFields: prepaidInvoiceCustomFields(order),
      memo: order.memo,
      footer: PREPAID_INVOICE_FOOTER,
      metadata: assistantCapMetadata(opts.assistantSpendCap),
    });
    invoiceId = created.invoiceId;
    await recordPrepaidInvoice(orderId, invoiceId);
  }

  const invoice = await provider.sendPrepaidInvoice({
    orderId,
    invoiceId,
    expectedSubtotalCents: lines.reduce(
      (sum, line) => sum + line.amountCents,
      0,
    ),
  });
  // tenancy: platform-operator write with no tenant scope, filtered by the order id
  // that openPrepaidOrder wrote for the verified orgId.
  await withSystemDb((tx) =>
    tx
      .update(schema.prepaidOrders)
      .set({ status: "open", updatedAt: new Date() })
      .where(
        and(
          eq(schema.prepaidOrders.id, orderId),
          eq(schema.prepaidOrders.status, "draft"),
        ),
      ),
  );

  let grant: PrepaidGrantResult | null = null;
  if (invoice.status === "paid") {
    // Stripe settled it on send (a customer balance covered it). invoice.paid
    // will say the same; the grant is fenced, so whichever lands first grants.
    grant = await grantPrepaidOrder(orderId, {
      trigger: "paid",
      stripeInvoiceId: invoiceId,
      assistantSpendCap: invoice.assistantSpendCap,
      now: opts.now,
    });
  } else if (order.grantOn === "issue") {
    grant = await grantPrepaidOrder(orderId, {
      trigger: "issue",
      stripeInvoiceId: invoiceId,
      assistantSpendCap: invoice.assistantSpendCap,
      now: opts.now,
    });
  }

  // tenancy: platform-operator read with no tenant scope, filtered by the order id
  // that openPrepaidOrder wrote for the verified orgId.
  const after = await withSystemDb((tx) => readOrder(tx, orderId));
  logger.info(
    {
      orderId,
      orgId: order.orgId,
      invoiceId,
      status: invoice.status,
      number: invoice.number,
    },
    "billing: prepaid order invoiced",
  );
  return { order: after ?? order, invoice, grant };
}

// ── 3. The grant ────────────────────────────────────────────────────────────

export interface PrepaidGrantResult {
  orderId: string;
  orgId: string;
  /** Units this call added to the bucket; 0 when already granted or none ordered. */
  unitsGranted: number;
  /** Credits this call granted; 0 when already granted or none ordered. */
  creditsGranted: number;
  /** The cap this call wrote; `undefined` when it wrote none. */
  assistantSpendCapCents: number | null | undefined;
  /** The bucket the units went to, this call or an earlier one. */
  bucketId: string | null;
  status: PrepaidOrderRow["status"];
}

/**
 * Grant the order's units and credits, each once.
 *
 * In one withSystemDb transaction, under an advisory lock on the order (two
 * deliveries of invoice.paid, or invoice.paid racing the issue-time grant,
 * queue here and the second sees the first's fences):
 *   - units: when `units_granted_at` is null and the order has units, add
 *     them to the current bucket's `purchased_gau` through ensureCurrentBucket
 *     (purchased units carry into later months) and set `units_granted_at`
 *     and `granted_bucket_id`;
 *   - credits: when `credits_granted_at` is null and the order has credits,
 *     grant a never-expiring `purchase` lot under `grant_prepaid_invoice`,
 *     referenced by the order id, so the ledger's unique index also refuses a
 *     second grant, and apply the order's assistant cap instruction;
 *   - on payment, set `status = 'paid'` and `paid_at`.
 *
 * `stripeInvoiceId`, when given, must be the invoice the row records: a paid
 * invoice that is not the order's own grants nothing and throws, so the
 * webhook records the error for an operator to read.
 */
export async function grantPrepaidOrder(
  orderId: string,
  opts: {
    trigger: "paid" | "issue";
    stripeInvoiceId?: string;
    assistantSpendCap: AssistantSpendCapChange;
    now?: Date;
  },
): Promise<PrepaidGrantResult> {
  const now = opts.now ?? new Date();
  // tenancy: webhook or platform-operator write with no tenant scope, filtered by
  // the order id; the row's orgId, not the caller, decides whose balance moves.
  const result = await withSystemDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepaid_order:${orderId}`}::text, 0))`,
    );
    const order = await readOrder(tx, orderId);
    if (!order) {
      throw new PrepaidOrderError(
        "prepaid_order_not_found",
        "no_order",
        `No prepaid order ${orderId}.`,
      );
    }
    if (
      opts.stripeInvoiceId !== undefined &&
      order.stripeInvoiceId !== opts.stripeInvoiceId
    ) {
      throw new PrepaidOrderError(
        "prepaid_order_conflict",
        "foreign_invoice",
        `Invoice ${opts.stripeInvoiceId} names order ${orderId}, which records invoice ${order.stripeInvoiceId ?? "(none)"}. Nothing granted.`,
      );
    }
    if (opts.trigger === "paid" && order.status === "void") {
      throw new PrepaidOrderError(
        "prepaid_order_closed",
        "void",
        `Order ${orderId} is void and cannot be paid. Nothing granted.`,
      );
    }
    if (
      opts.trigger === "issue" &&
      order.status !== "open" &&
      order.status !== "paid"
    ) {
      throw new PrepaidOrderError(
        "prepaid_order_closed",
        order.status,
        `Order ${orderId} is ${order.status}; it grants at issue only once its invoice is sent.`,
      );
    }

    const set: Partial<typeof schema.prepaidOrders.$inferInsert> = {
      updatedAt: now,
    };
    let unitsGranted = 0;
    let creditsGranted = 0;
    let assistantSpendCapCents: number | null | undefined;
    let bucketId = order.grantedBucketId;

    const quantity = Number(order.gauQuantity);
    if (quantity > 0 && order.unitsGrantedAt === null) {
      const { terms, subscription } = await readGauEntitlement(
        tx,
        order.orgId,
        now,
      );
      const bucket = await ensureCurrentBucket(tx, order.orgId, {
        period: periodFor(subscription, now),
        terms,
        usedDelta: 0,
        purchasedDelta: quantity,
      });
      unitsGranted = quantity;
      bucketId = bucket.id;
      set.unitsGrantedAt = now;
      set.grantedBucketId = bucket.id;
    }

    const credits = Number(order.creditCents);
    if (credits > 0 && order.creditsGrantedAt === null) {
      const granted = await grantCreditLotOnce(tx, {
        orgId: order.orgId,
        reason: CREDIT_REASONS.GRANT_PREPAID_INVOICE,
        referenceType: PREPAID_REFERENCE_TYPE,
        referenceId: order.id,
        amountCents: BigInt(credits),
        source: "purchase",
        grantedAt: now,
        expiresAt: null,
      });
      if (granted) creditsGranted = credits;
      set.creditsGrantedAt = now;
      if (opts.assistantSpendCap.kind === "set") {
        assistantSpendCapCents = await writeAssistantSpendCapOn(
          tx,
          order.orgId,
          opts.assistantSpendCap.capCents,
        );
      }
    }

    let status = order.status;
    if (opts.trigger === "paid" && order.status !== "paid") {
      status = "paid";
      set.status = "paid";
      set.paidAt = order.paidAt ?? now;
    }
    await tx
      .update(schema.prepaidOrders)
      .set(set)
      .where(eq(schema.prepaidOrders.id, orderId));

    return {
      orderId,
      orgId: order.orgId,
      unitsGranted,
      creditsGranted,
      assistantSpendCapCents,
      bucketId,
      status,
    } satisfies PrepaidGrantResult;
  });

  logger.info(
    { ...result, trigger: opts.trigger },
    result.unitsGranted > 0 || result.creditsGranted > 0
      ? "billing: prepaid order granted"
      : "billing: prepaid order already granted, nothing added",
  );

  if (result.creditsGranted > 0) {
    // The same event a credit-pack purchase writes. Emitted after the commit
    // and only by the call that granted, so a retry writes no second row; a
    // failed insert is logged and never undoes a grant already committed.
    try {
      await emitSecurityEventAsync({
        eventType: "billing.credits_purchased",
        actorUserId: null,
        orgId: result.orgId,
        workspaceId: null,
        capability: null,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: null,
      });
    } catch (err) {
      logger.error(
        {
          orderId,
          orgId: result.orgId,
          err: err instanceof Error ? err.message : String(err),
        },
        "billing: prepaid credits granted but the audit row failed to write",
      );
    }
  }
  return result;
}

// ── 4. Void and uncollectible ───────────────────────────────────────────────

/**
 * Mirror invoice.voided or invoice.marked_uncollectible onto the order.
 *
 * A paid order is left alone: Stripe voids no paid invoice, and an invoice
 * marked uncollectible can still be paid later, when invoice.paid moves the
 * order to `paid` and grants. An order that already granted (`grant_on =
 * 'issue'`) keeps its units and credits: the grant is recorded, not reversed,
 * and an error-level log names what stays granted so an operator decides
 * whether to reclaim it by hand.
 */
export async function closePrepaidOrder(
  orderId: string,
  opts: { status: "void" | "uncollectible"; stripeInvoiceId: string },
): Promise<PrepaidOrderRow> {
  // tenancy: webhook write with no tenant scope, filtered by the order id the
  // invoice metadata names, verified against the invoice id the row records.
  const outcome = await withSystemDb(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prepaid_order:${orderId}`}::text, 0))`,
    );
    const order = await readOrder(tx, orderId);
    if (!order) {
      throw new PrepaidOrderError(
        "prepaid_order_not_found",
        "no_order",
        `No prepaid order ${orderId}.`,
      );
    }
    if (order.stripeInvoiceId !== opts.stripeInvoiceId) {
      throw new PrepaidOrderError(
        "prepaid_order_conflict",
        "foreign_invoice",
        `Invoice ${opts.stripeInvoiceId} names order ${orderId}, which records invoice ${order.stripeInvoiceId ?? "(none)"}.`,
      );
    }
    if (order.status === "paid" || order.status === opts.status) {
      return { order, changed: false };
    }
    const updated = await tx
      .update(schema.prepaidOrders)
      .set({ status: opts.status, updatedAt: new Date() })
      .where(eq(schema.prepaidOrders.id, orderId))
      .returning();
    return { order: updated[0] ?? order, changed: true };
  });

  const { order } = outcome;
  if (
    outcome.changed &&
    (order.unitsGrantedAt !== null || order.creditsGrantedAt !== null)
  ) {
    logger.error(
      {
        orderId,
        orgId: order.orgId,
        status: opts.status,
        unitsGranted: order.unitsGrantedAt ? Number(order.gauQuantity) : 0,
        creditsGranted: order.creditsGrantedAt ? Number(order.creditCents) : 0,
        grantedBucketId: order.grantedBucketId,
      },
      "billing: prepaid order closed unpaid after its grant; the units and credits stay granted until an operator reclaims them",
    );
  } else {
    logger.info(
      {
        orderId,
        orgId: order.orgId,
        status: order.status,
        changed: outcome.changed,
      },
      "billing: prepaid order invoice closed",
    );
  }
  return order;
}
