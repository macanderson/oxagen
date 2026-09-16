// delete_approval_rule — take one auto-approval rule out of the workspace's
// rule set (MC spec §6.9 part 2; ADR-070).
//
// The role gate is the same as the write that created it (INV-29). The rule
// that is going carries no consequence check of its own: removing a rule can
// only send more calls to a person, never fewer.

import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import {
  readRules,
  requireRule,
  requireWorkspace,
  withCounters,
  writeRules,
} from "./_approval_rule";

export const approvalRuleDeleteHandler: CapabilityHandler<
  typeof approvalRuleDelete
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "delete_approval_rule");
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"] },
  );

  const out = await withTenantDb(async (tx) => {
    const rules = await readRules(tx, workspaceId);
    requireRule(rules, input.ruleId);
    const kept = rules.filter((r) => r.id !== input.ruleId);
    await writeRules(tx, workspaceId, kept);
    return withCounters(tx, workspaceId, kept);
  });

  await emitSecurityEventAsync({
    eventType: "approval_rule.deleted",
    actorUserId: actingUserId,
    orgId: ctx.orgId,
    workspaceId,
    capability: approvalRuleDelete.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return out;
};
