// billing.contract_terms.set.ts: handler for the set_contract_terms capability.
//
// The platform operator records an organization's negotiated governed-action
// terms (ADR-055 §2). replaceNegotiatedTerms (packages/billing) closes the
// org's open agreement at the new start and opens the new one in one
// transaction, after checking the figures against the table's CHECKs.
//
// No role gate, the way set_org_billing_terms has none: the capability is
// `platformOnly`, so the kernel refuses it without a platform-operator binding
// it minted itself (INV-31), and the caller is an operator script with no
// signed-in user for assertOrgRole to resolve.
//
// A figure the table would refuse is `invalid_input`, with the reason the
// billing module named, so the operator reads what to change instead of a
// constraint name. Re-running the same terms writes nothing and audits
// nothing.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import {
  billingContractTermsSet,
  type BillingContractTermsSetOutput,
} from "@oxagen/oxagen/contracts/billing.contract_terms.set";
import {
  ContractTermsError,
  replaceNegotiatedTerms,
  type NegotiatedTerms,
  type ReplacedNegotiatedTerms,
} from "@oxagen/billing";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { logger } from "./logger";

export type ContractTermsDeps = {
  /** Close the open agreement and open this one. Runs with no tenant scope. */
  replace: (terms: NegotiatedTerms) => Promise<ReplacedNegotiatedTerms>;
  /** Injected so a test can pin "now". */
  now?: () => Date;
};

export function createBillingContractTermsSetHandler(
  deps: ContractTermsDeps,
): CapabilityHandler<typeof billingContractTermsSet> {
  return async (input, ctx): Promise<BillingContractTermsSetOutput> => {
    const effectiveFrom = input.effectiveFrom
      ? new Date(input.effectiveFrom)
      : (deps.now?.() ?? new Date());

    let result: ReplacedNegotiatedTerms;
    try {
      result = await deps.replace({
        orgId: input.orgId,
        agreementRef: input.agreementRef,
        currency: input.currency,
        ratePerGauMicros: BigInt(input.ratePerGauMicros),
        blockSizeGau: input.blockSizeGau,
        includedGauPerMonth: input.includedGauPerMonth,
        effectiveFrom,
      });
    } catch (err) {
      if (err instanceof ContractTermsError) {
        throw new CapabilityError(
          billingContractTermsSet.name,
          "invalid_input",
          `${err.reason}: ${err.message}`,
        );
      }
      throw err;
    }

    if (result.changed) {
      // SOC 2 CC6.3: the rate an organisation is billed at, changed by someone
      // outside it. The same event set_org_billing_terms writes. Awaited: the
      // caller is a process that exits as soon as the invoke returns.
      await emitSecurityEventAsync({
        eventType: "billing.plan_changed",
        actorUserId: null,
        orgId: input.orgId,
        workspaceId: null,
        capability: billingContractTermsSet.name,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: ctx.requestId ?? null,
      });
    }

    const { current, previous } = result;
    logger.info(
      {
        orgId: current.orgId,
        agreementRef: current.agreementRef,
        effectiveFrom: current.effectiveFrom.toISOString(),
        changed: result.changed,
        requestId: ctx.requestId,
      },
      "billing.contract_terms.set: negotiated terms recorded",
    );

    return {
      orgId: current.orgId,
      agreementRef: current.agreementRef,
      currency: current.currency,
      ratePerGauMicros: current.ratePerGauMicros.toString(),
      blockSizeGau: current.blockSizeGau,
      includedGauPerMonth: current.includedGauPerMonth,
      effectiveFrom: current.effectiveFrom.toISOString(),
      changed: result.changed,
      previous:
        previous && previous.effectiveTo
          ? {
              agreementRef: previous.agreementRef,
              effectiveFrom: previous.effectiveFrom.toISOString(),
              effectiveTo: previous.effectiveTo.toISOString(),
            }
          : null,
    };
  };
}

export const billingContractTermsSetHandler =
  createBillingContractTermsSetHandler({ replace: replaceNegotiatedTerms });
