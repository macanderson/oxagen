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
// Switching invoice billing off on an org with uninvoiced overage must also
// close the accrual — claimInterimInvoice plus the settlement sequence. That
// lands in WL-31 with the rest of gau_settlements in motion; until then this
// handler writes the terms and nothing else.

import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  billingOrgTermsSet,
  type BillingOrgTermsSetOutput,
} from "@oxagen/oxagen/contracts/billing.org_terms.set";
import { setOrgBillingTerms, type OrgBillingTerms } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { logger } from "./logger";

/** The one write the handler makes. Runs with no tenant scope. */
export type OrgBillingTermsWriter = (
  terms: OrgBillingTerms,
) => Promise<OrgBillingTerms>;

export function createBillingOrgTermsSetHandler(
  write: OrgBillingTermsWriter,
): CapabilityHandler<typeof billingOrgTermsSet> {
  return async (input, ctx): Promise<BillingOrgTermsSetOutput> => {
    const stored = await write({
      orgId: input.orgId,
      approvedForInvoiceBilling: input.approvedForInvoiceBilling,
      invoiceGauMax: input.invoiceGauMax,
    });

    // ── Audit ─────────────────────────────────────────────────────────────
    // SOC 2 CC6.3: this is the commercial arrangement an organisation is
    // billed under, changed by someone outside that organisation. The
    // taxonomy's `billing.plan_changed` is the "the org's commercial terms
    // moved" event; actorUserId is null because an operator script has no
    // session, and requestId is the operator run's own correlation key.
    emitSecurityEvent({
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
        requestId: ctx.requestId,
      },
      "billing.org_terms.set: org billing terms updated",
    );

    return stored;
  };
}

export const billingOrgTermsSetHandler =
  createBillingOrgTermsSetHandler(setOrgBillingTerms);
