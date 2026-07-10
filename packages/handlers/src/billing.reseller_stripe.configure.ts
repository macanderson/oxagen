import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerStripeConfigure } from "@oxagen/oxagen/contracts/billing.reseller_stripe.configure";
import { configureResellerStripe } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerStripeConfigureHandler: CapabilityHandler<
  typeof resellerStripeConfigure
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const result = await configureResellerStripe(rc, {
    secretKey: input.secretKey,
    accountLabel: input.accountLabel ?? null,
  });
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_stripe_configured",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "configure_reseller_stripe",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return result;
};
