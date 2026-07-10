import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerAttributionRuleDelete } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.delete";
import { deleteResellerAttributionRule } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerAttributionRuleDeleteHandler: CapabilityHandler<
  typeof resellerAttributionRuleDelete
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const result = await deleteResellerAttributionRule(rc, { id: input.id });
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_attribution_rule_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "delete_reseller_attribution_rule",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return result;
};
