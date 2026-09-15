// The Organization › People view model (ARCHITECTURE.md §1.2, §3.3): the
// organization's members and its pending invitations, read from
// list_members {scope:"org"}. Fields are nullable exactly where the contract
// may not record them: a member's display name and an invitation's expiry.
import { z } from "zod";
import { PublicId, StoredOrgRole } from "./common";

const Member = z.object({
  id: PublicId,
  name: z.string().nullable(),
  email: z.string().min(1),
  role: StoredOrgRole,
  joinedAt: z.iso.datetime(),
});

const Invitation = z.object({
  id: PublicId,
  email: z.string().min(1),
  role: StoredOrgRole,
  invitedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

export const MemberList = z.object({
  members: z.array(Member),
  invitations: z.array(Invitation),
});
export type MemberList = z.infer<typeof MemberList>;
