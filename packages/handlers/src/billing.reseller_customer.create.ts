import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerCreate } from "@oxagen/oxagen/contracts/billing.reseller_customer.create";
import { createResellerCustomer } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerCreateHandler: CapabilityHandler<
  typeof resellerCustomerCreate
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const customer = await createResellerCustomer(rc, {
    name: input.name,
    externalRef: input.externalRef ?? null,
    pricePlanId: input.pricePlanId ?? null,
  });
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_customer_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "create_reseller_customer",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return { customer };
};
