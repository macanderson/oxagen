"use server";
import { resendMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.resend";
import { revokeMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.revoke";
import { INVITABLE_ROLES, type InvitableRole } from "./invitation-roles";
// The two writes on the People page (ARCHITECTURE.md §1.2): change a member's
// organization role and remove a member. Both run through the kernel seam for
// the organization the URL names, both are `noBillingGate` (INV-28, WL-22), and
// both are role-checked in their handler (INV-29): an Owner or an Admin writes,
// anyone else is answered `denied` with nothing changed. The handlers refuse the
// demotion or removal of the last owner with `HandlerError { code: "conflict",
// reason: "last_owner" }`, which the seam classifies as `conflict`.
//
// Organization › People also sends an invitation (#2964). It is the one write
// here whose contract is named for a workspace and records an organization
// row; `sendInvitation` below says why the picked scope grants nothing.
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
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
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

/**
 * A new workspace's draft: its name and slug, and its main repository as the
 * one `owner/name` text the form collects. `create_workspace` requires the main
 * repository (MC spec §10.1, §17 M0: a workspace cannot exist without one), so
 * the rename draft above stays two fields and this one is three.
 */
export type NewWorkspaceDraft = WorkspaceDraft & { mainRepo: string };

/**
 * `owner/name`, as a person types it or pastes it from GitHub: surrounding
 * space and a trailing `.git` are dropped, and anything that is not exactly two
 * non-empty segments is not a repository. The segments' own spelling is the
 * contract's to judge — `kernelWrite` pre-parses them with
 * `bind_main_repository`'s GitHub-shaped schema — so this only splits.
 */
function parseRepository(text: string): { owner: string; name: string } | null {
  const trimmed = text.trim().replace(/\.git$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (owner === undefined || name === undefined) return null;
  if (owner === "" || name === "") return null;
  return { owner, name };
}

/**
 * A workspace in this organization, created with its main repository: the
 * in-app path to a second one (#2964). The installation is never named here —
 * the handler resolves it from the org's GitHub authorization by the
 * repository's owner — so the draft carries only `owner/name`, and a value
 * that does not split into the two is refused as `invalid` on `mainRepo` with
 * no capability run.
 */
export async function createWorkspace(
  org: string,
  draft: NewWorkspaceDraft,
): Promise<ActionResult<{ slug: string }>> {
  const ctx = await requireViewer(org);
  const mainRepo = parseRepository(draft.mainRepo);
  if (mainRepo === null) {
    return {
      ok: false,
      reason: "invalid",
      code: "repository_unparsable",
      field: "mainRepo",
    };
  }
  const result = await kernelWrite(ctx, workspaceCreate, {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    mainRepo: { provider: "github", ...mainRepo },
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

/**
 * Archives a workspace: it leaves the switcher, its slug stays taken and its
 * records stay readable. Its API keys stop authenticating while it is archived
 * and none is revoked (ADR-105); the capability answers with how many.
 */
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

/**
 * The three roles `send_workspace_invite` offers, in the spelling its contract
 * takes. The handler title-cases the one picked into the organization role the
 * invitation row records (`mapRole`, packages/handlers/src/workspace.invite.send.ts),
 * so this is an organization role under a workspace-shaped name, and the
 * picker offers exactly what the contract admits.
 */
const isInvitable = (role: string): role is InvitableRole =>
  INVITABLE_ROLES.some((known) => known === role);

export type InvitationDraft = {
  email: string;
  /** One of INVITABLE_ROLES; anything else is refused on `role` before the kernel runs. */
  role: string;
  /** Left blank, the invitation is sent with no note. */
  message: string;
};

/** The invitation row the handler answered with: the one it made, or the one already pending. */
export type InvitationSent = { id: string; status: string; expiresAt: string };

/**
 * Invites someone to this organization.
 *
 * The capability is named for a workspace and declared `scoped`, but the row it
 * writes is the organization's: the handler inserts into `invitations` with
 * `orgId` and a title-cased organization role, and records no workspace column
 * (packages/handlers/src/workspace.invite.send.ts:35-50). The workspace the
 * kernel enters is invocation scope alone, and on this page that is the
 * org-only sentinel an `OrgCtx` carries, the same scope the other Organization
 * writes run under. So the dialog asks for no workspace and its copy grants
 * none: the invitation admits the person to the organization with the role
 * picked, and nothing more.
 *
 * A second invitation for an email that is already pending is not a failure.
 * The handler's insert conflicts, it re-reads the pending row and answers with
 * it (:58-76), so this returns `ok` with the existing invitation's id and the
 * page says the person was already invited.
 */
export async function sendInvitation(
  org: string,
  draft: InvitationDraft,
): Promise<ActionResult<InvitationSent>> {
  const ctx = await requireViewer(org);
  if (!isInvitable(draft.role)) {
    return {
      ok: false,
      reason: "invalid",
      code: "role_not_invitable",
      field: "role",
    };
  }
  const message = draft.message.trim();
  const result = await kernelWrite(ctx, workspaceInviteSend, {
    email: draft.email.trim(),
    role: draft.role,
    ...(message === "" ? {} : { message }),
  });
  return result.ok
    ? {
        ok: true,
        value: {
          id: result.value.id,
          status: result.value.status,
          expiresAt: result.value.expires_at,
        },
      }
    : result;
}

export async function resendInvitation(
  org: string,
  invitationPublicId: string,
): Promise<
  ActionResult<{
    invitationPublicId: string;
    status: "pending";
    expiresAt: string | null;
    delivery: "accepted" | "failed";
  }>
> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, resendMemberInvite, { invitationPublicId });
}

export async function revokeInvitation(
  org: string,
  invitationPublicId: string,
): Promise<
  ActionResult<{
    invitationPublicId: string;
    status: "revoked";
    expiresAt: string | null;
  }>
> {
  const ctx = await requireViewer(org);
  return kernelWrite(ctx, revokeMemberInvite, { invitationPublicId });
}
