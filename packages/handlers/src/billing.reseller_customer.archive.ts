import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerCustomerArchive } from "@oxagen/oxagen/contracts/billing.reseller_customer.archive";
import { archiveResellerCustomer } from "@oxagen/billing";
import { emitSecurityEvent } from "@oxagen/database/security";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerCustomerArchiveHandler: CapabilityHandler<
  typeof resellerCustomerArchive
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const result = await archiveResellerCustomer(rc, { id: input.id });
  // ── Emit audit event (fire-and-forget) — SOC2 CC6.3/CC6.8 ──────────────────
  emitSecurityEvent({
    eventType: "billing.reseller_customer_changed",
    actorUserId: ctx.userId ?? null,
    orgId: rc.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "archive_reseller_customer",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
  return result;
};
