import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerUpdate } from "@oxagen/oxagen/contracts/billing.reseller_customer.update";
import { updateResellerCustomer } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerUpdateHandler: CapabilityHandler<
  typeof resellerCustomerUpdate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const customer = await updateResellerCustomer(rc, input);
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_customer_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "update_reseller_customer",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return { customer };
};
