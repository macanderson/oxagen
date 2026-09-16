// The Organization contract outputs to their view models (ARCHITECTURE.md
// §3.4): list_members {scope:"org"} to People, narrowed to the org branch of
// its scope union (the adapter answers the workspace branch as unmappable);
// list_iam_roles to the role and permission catalogue, folded to the
// vocabulary the editor speaks; list_workspaces to the Workspaces section,
// carrying the public id so no database uuid reaches the page (INV-11). Each
// is typed from the contract's `_output`, so a nullable contract field cannot
// land in a required view field.
import type { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import type { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import type { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import type { z } from "zod";
import type {
  MemberList,
  RoleCatalog,
  WorkspaceList,
} from "@/data/contracts/org";
import type { ContractOutput } from "@/server/kernel";

type OrgRoster = Extract<ContractOutput<typeof listMembers>, { scope: "org" }>;

export function toMemberList(out: OrgRoster): z.input<typeof MemberList> {
  return {
    members: out.members.map((member) => ({
      id: member.id,
      name: member.name,
      email: member.email,
      role: member.role,
      joinedAt: member.joinedAt,
    })),
    invitations: out.invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      invitedAt: invitation.invitedAt,
      expiresAt: invitation.expiresAt,
    })),
  };
}

/**
 * A role's capability grants are already folded into catalogue permissions by
 * the read (ADR-063), so the view carries the permissions and drops the
 * per-capability grant rows: the editor speaks the catalogue, and a grant a
 * permission does not cover has no control to change it.
 */
export function toRoleCatalog(
  out: ContractOutput<typeof iamRoleList>,
): z.input<typeof RoleCatalog> {
  return {
    roles: out.roles.map((role) => ({
      id: role.id,
      name: role.name,
      description: role.description,
      scope: role.scopeKind,
      kind: role.kind,
      builtIn: role.isSystemDefault,
      permissions: role.permissions,
      heldBy: role.memberCount,
      createdBy: role.createdBy,
    })),
    catalog: out.catalog.map((entry) => ({
      permission: entry.id,
      group: entry.group,
      description: entry.description,
      capabilities: entry.capabilities,
    })),
    enforcement: {
      tier: out.enforcement.tier,
      enforced: out.enforcement.enforced,
    },
  };
}

export function toWorkspaceList(
  out: ContractOutput<typeof workspaceList>,
): z.input<typeof WorkspaceList> {
  return {
    workspaces: out.workspaces.map((workspace) => ({
      id: workspace.publicId,
      slug: workspace.slug,
      name: workspace.name,
      role: workspace.role,
      archivedAt: workspace.archivedAt,
    })),
  };
}
