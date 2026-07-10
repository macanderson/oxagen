import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerAttributionRuleSave } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.save";
import { saveResellerAttributionRule } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerAttributionRuleSaveHandler: CapabilityHandler<
  typeof resellerAttributionRuleSave
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const rule = await saveResellerAttributionRule(rc, {
    id: input.id,
    matchKind: input.matchKind,
    matchValue: input.matchValue,
    matchLabel: input.matchLabel,
    customerId: input.customerId,
    priority: input.priority,
  });
  return { rule };
};
