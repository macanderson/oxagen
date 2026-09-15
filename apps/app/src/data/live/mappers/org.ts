// list_members {scope:"org"} output to the People view model (ARCHITECTURE.md
// §3.4). Typed from the contract's `_output`, narrowed to the org branch of its
// scope union; the adapter answers the workspace branch as unmappable.
import type { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import type { z } from "zod";
import type { MemberList } from "@/data/contracts/org";
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
