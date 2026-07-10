// audit-exempt: read-only list of past rebill runs — no state change; covered by the kernel capability.invoke_* audit.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { resellerRebillListRuns } from "@oxagen/oxagen/contracts/billing.reseller_rebill.list_runs";
import { listResellerRebillRuns } from "@oxagen/billing";
import { requireResellerCtx } from "./reseller-ctx";

export const resellerRebillListRunsHandler: CapabilityHandler<
  typeof resellerRebillListRuns
> = async (input, ctx) => {
  const rc = requireResellerCtx(ctx);
  const runs = await listResellerRebillRuns(rc, {
    customerId: input.customerId,
    limit: input.limit,
  });
  return { runs };
};
