import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerPricePlanUpdate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.update";
import { updateResellerPricePlan } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerPricePlanUpdateHandler: CapabilityHandler<
  typeof resellerPricePlanUpdate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const pricePlan = await updateResellerPricePlan(rc, input);
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_price_plan_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "update_reseller_price_plan",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return { pricePlan };
};
