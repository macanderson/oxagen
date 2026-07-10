import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerAttributionRuleSave } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.save";
import { saveResellerAttributionRule } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
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
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_attribution_rule_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "save_reseller_attribution_rule",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return { rule };
};
