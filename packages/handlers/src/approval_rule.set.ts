// set_approval_rules — replace the workspace's auto-approval rules (MC spec
// §6.9 part 2, App. E; ADR-069).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, for the signed-in user
//      or the creator of the API key (resolveActingUserId). The kernel's IAM
//      check allows every capability for a non-enterprise org, so the handler
//      checks (INV-29).
//   2. One transaction: the guards of `assertRulesSavable` — every tool
//      pattern matches a declared tool, every measure a condition names is
//      declared by it, and the caller holds the org role accountable for every
//      consequence those tools carry — then the whole clause is replaced. A
//      refusal leaves the stored rules exactly as they were.
//   3. The new set is returned with its counters, so the page needs no second
//      read to redraw.

import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import {
  assertRulesSavable,
  publicUserId,
  requireWorkspace,
  stamp,
  withCounters,
  writeRules,
} from "./_approval_rule";

export const approvalRuleSetHandler: CapabilityHandler<
  typeof approvalRuleSet
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "set_approval_rules");
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: ["Owner", "Admin"] },
  );

  const at = new Date();
  const out = await withTenantDb(async (tx) => {
    await assertRulesSavable(tx, ctx, workspaceId, input.rules);
    const author = await publicUserId(tx, actingUserId);
    const rules = input.rules.map((rule) => stamp(rule, author, at));
    await writeRules(tx, workspaceId, rules);
    return withCounters(tx, workspaceId, rules, at);
  });

  await emitSecurityEventAsync({
    eventType: "approval_rule.changed",
    actorUserId: actingUserId,
    orgId: ctx.orgId,
    workspaceId,
    capability: approvalRuleSet.name,
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: null,
  });
  return out;
};
