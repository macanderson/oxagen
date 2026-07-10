import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerRebillPush } from "@oxagen/oxagen/contracts/billing.reseller_rebill.push";
import { pushResellerRebill } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerRebillPushHandler: CapabilityHandler<
  typeof resellerRebillPush
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const result = await pushResellerRebill(rc, {
    customerId: input.customerId,
    start: input.start,
    end: input.end,
    finalize: input.finalize,
  });
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_rebill_pushed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "push_reseller_rebill",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return result;
};
