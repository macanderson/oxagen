// billing.prepaid_invoice.create.ts: handler for the create_prepaid_invoice
// capability.
//
// The platform operator issues an enterprise's prepaid order: the licence for
// a period, governed action units and usage credits, on one Stripe invoice
// (ADR-158). The sequence is packages/billing/src/prepaid-orders.ts's:
//
//   1. resolve the defaults from the org's negotiated terms (currency,
//      agreement, rate); an order for units needs a rate, and only a
//      negotiated agreement supplies one;
//   2. openPrepaidOrder writes the `draft` row FIRST, keyed on the input's
//      orderId or a fresh one, so a re-run of the same order finds its row;
//   3. invoicePrepaidOrder creates, records, checks and sends the invoice,
//      and grants at issue for `grantOn: "issue"`;
//   4. audit, awaited, because the caller is a process that exits on return.
//
// No role gate: the capability is `platformOnly`, so the kernel refuses it
// without a platform-operator binding it minted itself (INV-31), and the
// caller is an operator script with no signed-in user.
//
// Refusals keep their meaning on the way out: a figure the table or the
// invoice cannot carry is `invalid_input`; an order id that names different
// lines, or an order whose invoice closed, is a `conflict`.

import { randomUUID } from "node:crypto";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingPrepaidInvoiceCreate,
  type BillingPrepaidInvoiceCreateInput,
  type BillingPrepaidInvoiceCreateOutput,
} from "@oxagen/oxagen/contracts/billing.prepaid_invoice.create";
import {
  invoicePrepaidOrder,
  openPrepaidOrder,
  prepaidOrderLines,
  PrepaidOrderError,
  readPrepaidOrderDefaults,
  resolvePrepaidOrderSpec,
  type PrepaidOrderDefaults,
  type PrepaidOrderRequest,
  type PrepaidOrderSpec,
} from "@oxagen/billing";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { toPrepaidOrderLine } from "./billing.prepaid_order.list";
import { logger } from "./logger";

export type PrepaidInvoiceDeps = {
  defaults: (orgId: string) => Promise<PrepaidOrderDefaults>;
  open: typeof openPrepaidOrder;
  invoice: typeof invoicePrepaidOrder;
  newOrderId: () => string;
};

const NAME = billingPrepaidInvoiceCreate.name;

/** The contract's input as the billing module's request: instants as Dates, the rate as a bigint. */
function requestOf(
  input: BillingPrepaidInvoiceCreateInput,
): PrepaidOrderRequest {
  return {
    orgId: input.orgId,
    agreementRef: input.agreementRef,
    poNumber: input.poNumber,
    currency: input.currency,
    licence: input.licence
      ? {
          amountCents: input.licence.amountCents,
          periodStart: new Date(input.licence.periodStart),
          periodEnd: new Date(input.licence.periodEnd),
        }
      : undefined,
    gau: input.gau
      ? {
          quantity: input.gau.quantity,
          ratePerGauMicros:
            input.gau.ratePerGauMicros === undefined
              ? undefined
              : BigInt(input.gau.ratePerGauMicros),
        }
      : undefined,
    creditsCents: input.creditsCents,
    daysUntilDue: input.daysUntilDue,
    grantOn: input.grantOn,
    memo: input.memo,
    assistantSpendCapCents: input.assistantSpendCapCents,
  };
}

/** The billing module's refusal as the surface's. */
function surfaced(err: unknown): unknown {
  if (!(err instanceof PrepaidOrderError)) return err;
  if (err.code === "invalid_prepaid_order") {
    return new CapabilityError(
      NAME,
      "invalid_input",
      `${err.reason}: ${err.message}`,
    );
  }
  return new HandlerError({
    code: err.code === "prepaid_order_not_found" ? "not_found" : "conflict",
    reason: err.reason,
    message: err.message,
  });
}

export function createBillingPrepaidInvoiceCreateHandler(
  deps: PrepaidInvoiceDeps,
): CapabilityHandler<typeof billingPrepaidInvoiceCreate> {
  return async (input, ctx): Promise<BillingPrepaidInvoiceCreateOutput> => {
    const orderId = input.orderId ?? deps.newOrderId();

    let outcome: Awaited<ReturnType<typeof invoicePrepaidOrder>>;
    let created: boolean;
    let spec: PrepaidOrderSpec;
    try {
      spec = resolvePrepaidOrderSpec(
        requestOf(input),
        await deps.defaults(input.orgId),
      );
    } catch (err) {
      throw surfaced(err);
    }
    try {
      ({ created } = await deps.open({
        id: orderId,
        spec,
        issuedByRequestId: ctx.requestId ?? null,
      }));
      outcome = await deps.invoice(orderId, {
        assistantSpendCap: spec.assistantSpendCap,
      });
    } catch (err) {
      logger.error(
        {
          orderId,
          orgId: input.orgId,
          requestId: ctx.requestId,
          err: err instanceof Error ? err.message : String(err),
        },
        "billing.prepaid_invoice.create: the order stopped before it was sent; re-run with its orderId to resume",
      );
      throw surfaced(err);
    }

    // SOC 2 CC6.3: an organisation's commercial arrangement (a licence period
    // and a prepaid balance) set by someone outside it; the event
    // set_org_billing_terms writes. The credits grant writes its own
    // billing.credits_purchased row when it lands.
    await emitSecurityEventAsync({
      eventType: "billing.plan_changed",
      actorUserId: null,
      orgId: input.orgId,
      workspaceId: null,
      capability: NAME,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    const { order, invoice, grant } = outcome;
    const lines = prepaidOrderLines(order).map(toPrepaidOrderLine);
    logger.info(
      {
        orderId,
        orgId: order.orgId,
        status: order.status,
        invoiceNumber: invoice.number,
        resumed: !created,
        requestId: ctx.requestId,
      },
      "billing.prepaid_invoice.create: prepaid order issued",
    );
    return {
      orderId,
      orgId: order.orgId,
      resumed: !created,
      status: order.status as BillingPrepaidInvoiceCreateOutput["status"],
      agreementRef: order.agreementRef,
      poNumber: order.poNumber,
      currency: order.currency,
      lines,
      totalMicros: lines
        .reduce((sum, line) => sum + BigInt(line.amountMicros), 0n)
        .toString(),
      stripeInvoiceId: order.stripeInvoiceId,
      invoiceNumber: invoice.number,
      hostedInvoiceUrl: invoice.hostedInvoiceUrl,
      invoicePdfUrl: invoice.invoicePdfUrl,
      grant: grant
        ? {
            unitsGranted: grant.unitsGranted,
            creditsGrantedCents: grant.creditsGranted,
            ...(grant.assistantSpendCapCents !== undefined
              ? { assistantSpendCapCents: grant.assistantSpendCapCents }
              : {}),
          }
        : null,
    };
  };
}

export const billingPrepaidInvoiceCreateHandler =
  createBillingPrepaidInvoiceCreateHandler({
    defaults: (orgId) => readPrepaidOrderDefaults(orgId),
    open: openPrepaidOrder,
    invoice: invoicePrepaidOrder,
    newOrderId: randomUUID,
  });
