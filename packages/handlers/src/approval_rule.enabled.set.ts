// set_approval_rule_enabled — switch one auto-approval rule on or off
// (MC spec §6.9 part 2; ADR-070).
//
// Switching ON re-checks the guards `set_approval_rules` applied when the rule
// was written: the declared tools it matches, and the org role accountable for
// their consequences. A tool's classification can change under a rule that is
// off, so the moment it starts deciding again it is checked against the
// workspace as it is now. Switching OFF needs no such check — it can only send
// more calls to a person.

import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import {
  assertRulesSavable,
  readRules,
  requireRule,
  requireWorkspace,
  withCounters,
  writeRules,
} from "./_approval_rule";

export const approvalRuleEnabledSetHandler: CapabilityHandler<
  typeof approvalRuleEnabledSet
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "set_approval_rule_enabled");
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"] },
  );

  const out = await withTenantDb(async (tx) => {
    const rules = await readRules(tx, workspaceId);
    const rule = requireRule(rules, input.ruleId);
    if (input.enabled) await assertRulesSavable(tx, ctx, workspaceId, [rule]);
    const next = rules.map((r) =>
      r.id === input.ruleId ? { ...r, enabled: input.enabled } : r,
    );
    await writeRules(tx, workspaceId, next);
    return withCounters(tx, workspaceId, next);
  });

  await emitSecurityEventAsync({
    eventType: "approval_rule.changed",
    actorUserId: actingUserId,
    orgId: ctx.orgId,
    workspaceId,
    capability: approvalRuleEnabledSet.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return out;
};
