"use server";
// The two writes on the People page (ARCHITECTURE.md §1.2): change a member's
// organization role and remove a member. Both run through the kernel seam for
// the organization the URL names, both are `noBillingGate` (INV-28, WL-22), and
// both are role-checked in their handler (INV-29): an Owner or an Admin writes,
// anyone else is answered `denied` with nothing changed. The handlers refuse the
// demotion or removal of the last owner with `HandlerError { code: "conflict",
// reason: "last_owner" }`, which the seam classifies as `conflict`.
//
// The Organization writes a person starts from the Roles page and the
// Workspaces section (#2964), each through the kernel seam for the
// organization viewer the URL names. Every contract here is `noBillingGate`
// and role-checked in its handler (INV-29): an org Owner or Admin edits roles
// and workspaces, and a refusal comes back as `denied` with nothing changed.
//
// No field is validated twice: `kernelWrite` pre-parses the input with the
// contract's own schema and answers `invalid` with the offending field before
// the kernel runs (§3.2 step 5), so a blank name, an unknown permission or a
// malformed slug is refused without a capability being invoked. The one check
// made here is the role scope, which arrives from a select a client controls
// and reaches a contract field with two legal values.
import { iamRoleCreate } from "@oxagen/oxagen/contracts/iam.role.create";
import { iamRoleDelete } from "@oxagen/oxagen/contracts/iam.role.delete";
import { iamRoleGrantsSet } from "@oxagen/oxagen/contracts/iam.role.grants.set";
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { workspaceArchive } from "@oxagen/oxagen/contracts/workspace.archive";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { GrantableOrgRole } from "@/data/contracts/org";
import type { ActionResult } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

export type RoleDraft = {
  name: string;
  /** Left blank, the role is stored with no description. */
  description: string;
  /** "org" or "workspace"; any other value is refused before the kernel runs. */
  scope: string;
  permissions: string[];
};

export type RoleWritten = { id: string; name: string };

/** A custom role over the catalogue's permissions; one allow grant per capability they name. */
export async function createRole(
  org: string,
  draft: RoleDraft,
): Promise<ActionResult<RoleWritten>> {
  const ctx = await requireViewer(org);
  if (draft.scope !== "org" && draft.scope !== "workspace") {
    return {
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "scopeKind",
    };
  }
  const description = draft.description.trim();
  const result = await kernelWrite(ctx, iamRoleCreate, {
    name: draft.name.trim(),
    scopeKind: draft.scope,
    description: description === "" ? null : description,
    permissions: draft.permissions,
  });
  return result.ok
    ? {
        ok: true,
        value: { id: result.value.role.id, name: result.value.role.name },
      }
    : result;
}

/** Replaces the role's grants with the permission set given; a built-in role is refused. */
export async function setRolePermissions(
  org: string,
  roleId: string,
  permissions: string[],
): Promise<ActionResult<RoleWritten>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, iamRoleGrantsSet, {
    roleId,
    permissions,
  });
  return result.ok
    ? {
        ok: true,
        value: { id: result.value.role.id, name: result.value.role.name },
      }
    : result;
}

/** Deletes a custom role nobody holds; a role with a holder is a conflict. */
export async function deleteRole(
  org: string,
  roleId: string,
): Promise<ActionResult<RoleWritten>> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, iamRoleDelete, { roleId });
}

export type WorkspaceDraft = { name: string; slug: string };

/** A workspace in this organization: the in-app path to a second one (#2964). */
export async function createWorkspace(
  org: string,
  draft: WorkspaceDraft,
): Promise<ActionResult<{ slug: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, workspaceCreate, {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
  });
  return result.ok ? { ok: true, value: { slug: result.value.slug } } : result;
}

/** Renames a workspace of this organization, and re-slugs it; the old slug keeps redirecting. */
export async function renameWorkspace(
  org: string,
  workspaceId: string,
  draft: WorkspaceDraft,
): Promise<ActionResult<{ slug: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, workspaceSettingsWrite, {
    workspaceId,
    name: draft.name.trim(),
    slug: draft.slug.trim(),
  });
  return result.ok ? { ok: true, value: { slug: result.value.slug } } : result;
}

/** Archives a workspace: it leaves the switcher, its slug stays taken and its records stay readable. */
export async function archiveWorkspace(
  org: string,
  workspaceId: string,
): Promise<ActionResult<{ archivedAt: string }>> {
  const ctx = await requireViewer(org);
  const result = await kernelWrite(ctx, workspaceArchive, { workspaceId });
  return result.ok
    ? { ok: true, value: { archivedAt: result.value.archivedAt } }
    : result;
}

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
