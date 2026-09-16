// list_members {scope:"org"} and list_api_keys output to the Organization view
// models (ARCHITECTURE.md §3.4). Typed from the contracts' `_output`, with the
// member roster narrowed to the org branch of its scope union; the adapter
// answers the workspace branch as unmappable.
import type { apiKeyList } from "@oxagen/oxagen/contracts/api.key.list";
import type { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import type { z } from "zod";
import type { ApiKeyList, MemberList } from "@/data/contracts/org";
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
 * The key's public id is the only id the view carries (INV-11). Every field is
 * named here, so a field the contract gains later — a secret among them —
 * reaches the page only when this mapper is changed to copy it.
 */
export function toApiKeys(
  out: ContractOutput<typeof apiKeyList>,
): z.input<typeof ApiKeyList> {
  return out.items.map((key) => ({
    id: key.publicId,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    rotatable: key.rotatable,
  }));
}
