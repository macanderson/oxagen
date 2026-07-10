import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerAttributionRuleDelete } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.delete";
import { deleteResellerAttributionRule } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerAttributionRuleDeleteHandler: CapabilityHandler<
  typeof resellerAttributionRuleDelete
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  return deleteResellerAttributionRule(rc, { id: input.id });
};
