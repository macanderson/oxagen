/** Provider lifecycle stays in AI. Billing owns admission and atomic settlement. */
import {
  admitUsage,
  finalizeUsage,
  type ChargeUsageArgs,
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
