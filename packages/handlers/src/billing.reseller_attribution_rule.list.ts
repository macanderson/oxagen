// audit-exempt: read-only list of reseller attribution rules — no state change; covered by the kernel capability.invoke_* audit.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerAttributionRuleList } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.list";
import { listResellerAttributionRules } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerAttributionRuleListHandler: CapabilityHandler<
  typeof resellerAttributionRuleList
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const rules = await listResellerAttributionRules(rc, {
    customerId: input.customerId,
  });
  return { rules };
};
