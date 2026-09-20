// set_approval_rules — replace the workspace's auto-approval rules (MC spec
// §6.9 part 2, App. E; ADR-070).
//
//   1. Role gate — assertOrgRole: org Owner or Admin, for the signed-in user
//      or the creator of the API key (resolveActingUserId). The kernel's IAM
//      check allows every capability for a non-enterprise org, so the handler
//      checks (INV-29).
//   2. One transaction, under the workspace's rule-set lock:
//      a. When the caller sends `replaces`, the stored rules must still be the
//         set it read, or the write is refused as `rule_set_changed`. That is
//         what makes a one-rule edit built on an earlier read safe: a rule
//         another person deleted or switched off since cannot be written back.
//      b. A rule whose body matches the stored rule of the same id is carried
//         through as stored, stamp and all. Only new and changed rules run
//         the guards of `assertRulesSavable` — every tool pattern matches a
//         declared tool, every measure a condition names is declared by it,
//         and the caller holds the org role accountable for every consequence
//         those tools carry — and only they are stamped. Re-stamping an
//         unchanged rule would re-authorise it without anyone choosing to:
//         a rule held back as `consequences_changed` would start releasing
//         calls again because a different rule was edited. A rule the
//         caller names in `saving` is checked and stamped even when its body
//         is unchanged: saving a held rule again is how it is re-authorised.
//      c. The whole clause is replaced. A refusal leaves the stored rules
//         exactly as they were.
//   3. The new set is returned with its counters, so the page needs no second
//      read to redraw.

import { withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import {
  assertRulesSavable,
  lockWorkspaceRuleSet,
  publicUserId,
  readRules,
  requireWorkspace,
  ruleBodyKey,
  sameRuleBodies,
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
    // Serialises with every other rule write on this workspace.
    await lockWorkspaceRuleSet(tx, workspaceId);
    const stored = await readRules(tx, workspaceId);
    if (
      input.replaces !== undefined &&
      !sameRuleBodies(stored, input.replaces)
    ) {
      throw new HandlerError({
        code: "conflict",
        reason: "rule_set_changed",
        message:
          "The workspace's auto-approval rules changed after they were read; nothing was written",
      });
    }
    const storedById = new Map(stored.map((rule) => [rule.id, rule]));
    const saving = new Set(input.saving ?? []);
    const unchanged = (rule: (typeof input.rules)[number]) => {
      if (saving.has(rule.id)) return false;
      const before = storedById.get(rule.id);
      return before !== undefined && ruleBodyKey(before) === ruleBodyKey(rule);
    };
    const authored = await assertRulesSavable(
      tx,
      { ...ctx, userId: actingUserId, apiKeyId: null },
      workspaceId,
      input.rules.filter((rule) => !unchanged(rule)),
    );
    const author = await publicUserId(tx, actingUserId);
    const rules = input.rules.map((rule) =>
      unchanged(rule)
        ? storedById.get(rule.id)!
        : stamp(rule, author, at, authored.get(rule.id)),
    );
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
