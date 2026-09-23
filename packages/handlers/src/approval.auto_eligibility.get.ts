// get_auto_eligibility — the auto-approval evaluation recorded for one
// approval request, and who resolved it (MC spec §6.9 part 2, §6.10; ADR-070).
//
// Read, never recomputed. The row carries the rule that was read and every
// reason the call did not qualify, written when the call was parked, so the
// page shows the decision that was made rather than what today's rules would
// say about it (INV-10).
//
// Where the request stands is read from its resolution and expiry, never from
// who resolved it (#3521): a mandate revoke or expiry writes `expired` with no
// resolver, and a request past its expiry is closed before the sweep writes
// anything. `resolve_approval` refuses both (`approval_expired`), so the
// state here says so before an operator writes a reason.
//
// audit-exempt: read-only; the kernel's capability.invoke_* row is the audit.

import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  type ApprovalState,
  approvalAutoEligibilityGet,
} from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import { isApprovalPublicId } from "@oxagen/oxagen/contracts/agent.approval.resolve";
import { isFloorReason } from "@oxagen/rules";
import { and, eq } from "drizzle-orm";
import { requireWorkspace } from "./_approval_rule";

const ar = schema.approvalRequests;

/**
 * Where a request stands: its recorded resolution, or `expired` once its
 * expiry has passed with none recorded, or `pending`. The same two conditions
 * `resolve_approval` matches a pending row on (`resolution IS NULL` and
 * `expires_at > now()`), so this never calls a row pending that a decision
 * would be refused on.
 */
export function approvalStateOf(
  row: { resolution: string | null; expiresAt: Date },
  now: Date,
): ApprovalState {
  switch (row.resolution) {
    case "approved":
    case "denied":
    case "expired":
      return row.resolution;
    case null:
      return row.expiresAt.getTime() > now.getTime() ? "pending" : "expired";
    default:
      // approval_requests_resolution_check admits no other value. A row that
      // carried one would still be refused by resolve_approval, which matches
      // `resolution IS NULL`, so it is closed rather than offered as pending.
      return "expired";
  }
}

export const approvalAutoEligibilityGetHandler: CapabilityHandler<
  typeof approvalAutoEligibilityGet
> = async (input, ctx) => {
  const workspaceId = requireWorkspace(ctx, "get_auto_eligibility");
  await assertOrgRole(
    { ...ctx, userId: await resolveActingUserId(ctx) },
    { org: ["Owner", "Admin", "Member"] },
  );

  // The id arrives as the public id (apr_…) or the row uuid (#2906).
  const byId = isApprovalPublicId(input.approvalId)
    ? eq(ar.publicId, input.approvalId)
    : eq(ar.id, input.approvalId);

  // The person who answered is reached through the declared relation
  // (`packages/database/src/relations.ts`), never a cross-schema join written
  // here: `agent.approval_requests` and `auth.users` are different domains.
  const row = await withTenantDb((tx) =>
    tx.query.approvalRequests.findFirst({
      where: and(
        byId,
        eq(ar.orgId, ctx.orgId),
        eq(ar.workspaceId, workspaceId),
      ),
      columns: {
        autoRuleId: true,
        resolvedReasons: true,
        resolvedByPolicy: true,
        resolution: true,
        expiresAt: true,
      },
      with: { resolvedBy: { columns: { publicId: true, displayName: true } } },
    }),
  );
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "approval_not_found",
      message: "No such approval request in this workspace",
    });
  }

  const reasons = row.resolvedReasons;
  // resolved_by_policy and resolved_by_user_id are exclusive, so a name is
  // carried only when the approver is the person, never beside a rule.
  const person = row.resolvedByPolicy === null ? row.resolvedBy : null;
  const name = person?.displayName?.trim() ?? "";
  return {
    approvalId: input.approvalId,
    state: approvalStateOf(row, new Date()),
    resolvedBy:
      row.resolvedByPolicy ??
      (person === null ? null : `user:${person.publicId}`),
    resolvedByName: name === "" ? null : name.slice(0, 256),
    eligibility:
      row.autoRuleId === null
        ? null
        : {
            ruleId: row.autoRuleId,
            ok: reasons.length === 0,
            reasons,
            floor: reasons.some(isFloorReason),
          },
  };
};
