// audit-exempt: read-only contracted-terms fetch — no state mutation; the kernel capability.invoke_* audit covers access.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { billingContractRateGet } from "@oxagen/oxagen/contracts/billing.contract_rate.get";
import { resolveContractTerms } from "@oxagen/billing";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";

/**
 * get_contract_rate — the organisation's contracted governed-action terms
 * (ADR-055 §3, apps/app/ARCHITECTURE.md §3.9).
 *
 * The figures come from `resolveContractTerms` on every call: the effective
 * `billing.contract_terms` row when the org has one, otherwise the published
 * terms on the `billing.plans` row of its entitled subscription, otherwise
 * the Free plan's. Nothing copies a tier into the org, so a subscription
 * change shows on the next read. `ACTION_RATE_BANDS` is the dollar model's
 * global band table and prices nothing here.
 *
 * `ratePerGauMicros` leaves as a decimal string: the resolver holds it as a
 * bigint and JSON has no integer wide enough to promise, so the one money
 * figure on the billing page never becomes a float.
 */
export const billingContractRateGetHandler: CapabilityHandler<
  typeof billingContractRateGet
> = async (_input, ctx) => {
  // Role gate (ARCHITECTURE.md §3.2, INV-29): the contract's defaultRoles are
  // Owner, Admin and Billing, and the kernel's IAM check enforces them for
  // enterprise orgs only, so the handler checks them itself, for the signed-in
  // user or the creator of the API key.
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin", "Billing"] },
  );

  const terms = await resolveContractTerms(ctx.orgId);

  return {
    source: terms.source,
    agreementRef: terms.source === "negotiated" ? terms.agreementRef : null,
    tier: terms.tier,
    currency: terms.currency,
    ratePerGauMicros: terms.ratePerGauMicros.toString(),
    blockSizeGau: terms.blockSizeGau,
    includedGauPerMonth: terms.includedGauPerMonth,
    effectiveFrom: terms.effectiveFrom.toISOString(),
    effectiveTo:
      terms.effectiveTo === null ? null : terms.effectiveTo.toISOString(),
  };
};
