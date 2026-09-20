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
  lockWorkspaceRuleSet,
  readRules,
  publicUserId,
  requireRule,
  requireWorkspace,
  stamp,
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

  const at = new Date();
  const out = await withTenantDb(async (tx) => {
    // Serialises with every other rule write on this workspace. Two operators
    // switching off two DIFFERENT rules at once both stick; without the lock
    // the second write would carry a stale copy of the first's rule and undo
    // it, on the one capability that is reached for during an incident.
    await lockWorkspaceRuleSet(tx, workspaceId);
    const rules = await readRules(tx, workspaceId);
    const rule = requireRule(rules, input.ruleId);
    // Switching ON re-runs the gate, so it also re-stamps the consequences the
    // rule is now accountable for — that re-authorisation is what clears a
    // `consequences_changed` rule. Switching OFF runs neither: it takes no new
    // authority, and re-stamping there would silently bless a tool that was
    // classified since, so the existing stamp is carried through untouched.
    const authored = input.enabled
      ? await assertRulesSavable(
          tx,
          { ...ctx, userId: actingUserId, apiKeyId: null },
          workspaceId,
          [rule],
        )
      : undefined;
    // Re-stamp the toggled rule. `createdBy` and `createdAt` are documented as
    // whoever LAST wrote the rule and when (approvalRuleSchema), and a toggle
    // is a write: it is the change that decides whether this rule releases
    // calls without a person. Keeping the original author would have
    // list_approval_rules attribute the currently active state to someone who
    // did not choose it, which is the one question an auditor asks of this
    // record. Only the toggled rule is re-stamped; the others are untouched.
    const author = await publicUserId(tx, actingUserId);
    const next = rules.map((r) =>
      r.id === input.ruleId
        ? {
            ...stamp(
              { ...r, enabled: input.enabled },
              author,
              at,
              authored?.get(r.id) ?? r.authoredConsequences,
            ),
            disabledReason: input.enabled ? undefined : r.disabledReason,
          }
        : r,
    );
    await writeRules(tx, workspaceId, next);
    return withCounters(tx, workspaceId, next, at);
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
