import { requireEnv } from "@oxagen/config/env";

/** True when RLS policies should actively filter (flag on → no bypass GUC). */
export function rlsEnforced(): boolean {
  return requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"])
    .TENANT_RLS_ENFORCEMENT_ENABLED;
}
