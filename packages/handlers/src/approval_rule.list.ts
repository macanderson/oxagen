// list_approval_rules — the workspace's auto-approval rules with what each one
// did in the last 30 days (MC spec §6.9 part 2, ADR-070).
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import { withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { readRules, requireWorkspace, withCounters } from "./_approval_rule";

export const approvalRuleListHandler: CapabilityHandler<
  typeof approvalRuleList
> = async (_input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "list_approval_rules");
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin", "Compliance"] },
  );
  return withTenantDb(async (tx) =>
    withCounters(tx, workspaceId, await readRules(tx, workspaceId)),
  );
};
