"use server";
// The two writes on the People page (ARCHITECTURE.md §1.2): change a member's
// organization role and remove a member. Both run through the kernel seam for
// the organization the URL names, both are `noBillingGate` (INV-28, WL-22), and
// both are role-checked in their handler (INV-29): an Owner or an Admin writes,
// anyone else is answered `denied` with nothing changed. The handlers refuse the
// demotion or removal of the last owner with `HandlerError { code: "conflict",
// reason: "last_owner" }`, which the seam classifies as `conflict`.
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { GrantableOrgRole } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

/**
 * The IAM role name (`iam.roles.name`) for a role the roster prints. The
 * contract takes the seeded name and answers `not_found` for anything else.
 */
const IAM_ROLE_NAME: Record<GrantableOrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  billing: "Billing",
  compliance: "Compliance",
};

/**
 * Replaces the member's organization role assignment. A role outside the
 * grantable set is refused here, so a picker that offers one is a refusal with
 * its field rather than a `not_found` from the handler.
 */
export async function changeMemberRole(
  org: string,
  memberId: string,
  role: string,
): Promise<ActionResult<{ role: GrantableOrgRole }>> {
  const ctx = await requireViewer(org);
  const parsed = GrantableOrgRole.safeParse(role);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid",
      code: "role_not_grantable",
      field: "role",
    };
  }
  const result = await kernelWrite(ctx, orgMemberRoleChange, {
    targetUserId: memberId,
    newRole: IAM_ROLE_NAME[parsed.data],
  });
  return result.ok ? { ok: true, value: { role: parsed.data } } : result;
}

/** Ends the membership: role assignments revoked, principal retired, CLI keys revoked. */
export async function removeOrgMember(
  org: string,
  memberId: string,
): Promise<ActionResult<{ memberId: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, orgMemberRemove, {
    targetUserId: memberId,
  });
  return result.ok
    ? { ok: true, value: { memberId: result.value.targetUserId } }
    : result;
}
