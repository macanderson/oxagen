// billing.org_terms.set.ts — handler for the set_org_billing_terms capability.
//
// The platform-operator half of the two billing-terms writes (ADR-055 §5,
// apps/app/ARCHITECTURE.md §3.9 item 12): whether an organisation is approved
// for invoice billing, and the uninvoiced-overage ceiling at which an interim
// invoice is cut.
//
// There is no role gate here, and that is not an omission. The capability is
// `platformOnly`, so the kernel refuses it before the IAM check unless the
// context carries a platform-operator binding the kernel itself minted
// (INV-31, packages/oxagen/src/platform-operator.ts); the caller is an
// operator script with no signed-in user, so there is no principal for
// assertOrgRole to resolve and no organisation it belongs to.
//
// The capability is unscoped and the call carries no tenant, so the upsert
// runs on withSystemDb (inside setOrgBillingTerms) keyed on the input's orgId.
//
// Switching invoice billing off closes the accrual in the same call:
// closeInvoiceAccrual closes every ended month the close job has not closed
// yet (a period_close settlement for its uninvoiced overage), then claims
// every uninvoiced GAU of the current bucket as one interim settlement and
// invoices it, so no overage is stranded between the modes
// (apps/app/ARCHITECTURE.md §3.9 item 12). It runs before the write, while
// the org is still invoice-billed, so a write that fails leaves the org
// invoice-billed with legitimate invoices and a re-run of the script finds
// nothing left to claim. Turning
// invoice billing on writes no settlement: purchased units stay usable as carry.
//
// The same call sets the org's monthly cap on platform-paid assistant tokens
// (ADR-053 §3) when the input carries `assistantSpendCapCents`. The mode's two
// fields are set together or not at all (the contract refuses one without the
// other), so a cap-only call leaves the mode alone and closes no accrual. The
// output is the three terms as they stand after the call.

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  billingOrgTermsSet,
  type BillingOrgTermsSetOutput,
} from "@oxagen/oxagen/contracts/billing.org_terms.set";
import {
  closeInvoiceAccrual,
  readAssistantSpendCap,
  readOrgBillingSettings,
  setAssistantSpendCap,
  setOrgBillingTerms,
  type OrgBillingTerms,
  type OrgGauBillingSettings,
} from "@oxagen/billing";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { logger } from "./logger";

/** The one write the handler makes. Runs with no tenant scope. */
export type OrgBillingTermsWriter = (
  terms: OrgBillingTerms,
) => Promise<OrgBillingTerms>;

/** What the handler reads and writes. Every one runs with no tenant scope. */
export type OrgBillingTermsDeps = {
  /** The org's billing mode before this call. */
  current: (
    orgId: string,
  ) => Promise<
    Pick<OrgGauBillingSettings, "approvedForInvoiceBilling" | "invoiceGauMax">
  >;
  write: OrgBillingTermsWriter;
  /** Invoice the uninvoiced overage of every ended, unclosed month and of the current bucket. */
  closeAccrual: (orgId: string) => Promise<unknown>;
  /** The org's assistant spend cap; null is no cap. */
  readAssistantSpendCap: (orgId: string) => Promise<number | null>;
  /** Store the org's assistant spend cap and return what was stored. */
  writeAssistantSpendCap: (
    orgId: string,
    capCents: number | null,
  ) => Promise<number | null>;
};

export function createBillingOrgTermsSetHandler(
  deps: OrgBillingTermsDeps,
): CapabilityHandler<typeof billingOrgTermsSet> {
  return async (input, ctx): Promise<BillingOrgTermsSetOutput> => {
    const before = await deps.current(input.orgId);
    let terms: OrgBillingTerms = {
      orgId: input.orgId,
      approvedForInvoiceBilling: before.approvedForInvoiceBilling,
      invoiceGauMax: before.invoiceGauMax,
    };
    if (
      input.approvedForInvoiceBilling !== undefined &&
      input.invoiceGauMax !== undefined
    ) {
      if (
        before.approvedForInvoiceBilling &&
        !input.approvedForInvoiceBilling
      ) {
        await deps.closeAccrual(input.orgId);
      }
      terms = await deps.write({
        orgId: input.orgId,
        approvedForInvoiceBilling: input.approvedForInvoiceBilling,
        invoiceGauMax: input.invoiceGauMax,
      });
    }

    const assistantSpendCapCents =
      input.assistantSpendCapCents !== undefined
        ? await deps.writeAssistantSpendCap(
            input.orgId,
            input.assistantSpendCapCents,
          )
        : await deps.readAssistantSpendCap(input.orgId);
    const stored: BillingOrgTermsSetOutput = {
      ...terms,
      assistantSpendCapCents,
    };

    // ── Audit ─────────────────────────────────────────────────────────────
    // SOC 2 CC6.3: this is the commercial arrangement an organisation is
    // billed under, changed by someone outside that organisation. The
    // taxonomy's `billing.plan_changed` is the "the org's commercial terms
    // moved" event; actorUserId is null because an operator script has no
    // session, and requestId is the operator run's own correlation key.
    //
    // Awaited: the caller is a process that exits as soon as the invoke
    // returns, and a fire-and-forget insert would race `closeDatabase()` and
    // `process.exit`. A row that fails all its retries rejects here, after the
    // terms are stored; the operator sees the failure and re-runs the
    // idempotent upsert.
    await emitSecurityEventAsync({
      eventType: "billing.plan_changed",
      actorUserId: null,
      orgId: stored.orgId,
      workspaceId: null,
      capability: billingOrgTermsSet.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

    logger.info(
      {
        orgId: stored.orgId,
        approvedForInvoiceBilling: stored.approvedForInvoiceBilling,
        invoiceGauMax: stored.invoiceGauMax,
        assistantSpendCapCents: stored.assistantSpendCapCents,
        requestId: ctx.requestId,
      },
      "billing.org_terms.set: org billing terms updated",
    );

    return stored;
  };
}

export const billingOrgTermsSetHandler = createBillingOrgTermsSetHandler({
  current: (orgId) => readOrgBillingSettings(orgId, { system: true }),
  write: setOrgBillingTerms,
  closeAccrual: (orgId) => closeInvoiceAccrual(orgId),
  readAssistantSpendCap,
  writeAssistantSpendCap: setAssistantSpendCap,
});
