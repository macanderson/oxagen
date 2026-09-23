/** Provider lifecycle stays in AI. Billing owns admission and atomic settlement. */
import {
  admitUsage,
  finalizeUsage,
  voidUsage,
  type ChargeUsageArgs,
  type UsageVoidReason,
} from "@oxagen/billing";
import { stampTokenUsage, type TokenUsageRow } from "@oxagen/telemetry";
import { getScope, runInTenantScope } from "@oxagen/tenancy";

export async function admitTokenUsage(
  orgId: string,
  workspaceId: string,
): Promise<string> {
  return runInTenantScope(getScope() ?? { orgId, workspaceId }, () =>
    admitUsage(orgId, workspaceId),
  );
}

export async function recordTokenUsage(
  id: string,
  row: TokenUsageRow,
  charge?: ChargeUsageArgs,
  complete = true,
): Promise<void> {
  const [stamped] = stampTokenUsage([row]);
  if (!stamped) throw new Error("Usage row is missing.");
  await runInTenantScope(
    getScope() ?? { orgId: row.org_id, workspaceId: row.workspace_id },
    () => finalizeUsage({ id, row: stamped, charge, complete }),
  );
}

/**
 * Close an admission whose provider call ended before any usage was reported.
 * Nothing is staged and nothing is charged; the row stops counting as
 * incomplete. See `voidUsage` for the conditional update that makes this safe
 * beside a late usage report.
 */
export async function voidTokenUsage(
  id: string,
  orgId: string,
  workspaceId: string,
  reason: UsageVoidReason,
): Promise<void> {
  await runInTenantScope(getScope() ?? { orgId, workspaceId }, () =>
    voidUsage({ id, orgId, workspaceId, reason }),
  );
}
