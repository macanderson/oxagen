// The invitation a person opens at /invite/[token], as the page needs it. Enums
// follow spec App. A (`org.org_users.role`) and the live `org.invitations.status`
// check constraint. The Organization page's list of invitations is `Invitation`
// in ./org.ts; this is the single invitation behind one public token.
import { z } from "zod";
import { OrgRole } from "./common";

export const InvitationStatus = z.enum([
  "pending",
  "accepted",
  "declined",
  "revoked",
  "expired",
]);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const InvitationView = z.object({
  token: z.string().min(1),
  orgName: z.string().min(1),
  orgSlug: z.string().min(1),
  email: z.string().min(1),
  role: OrgRole,
  status: InvitationStatus,
  inviterName: z.string().nullable(),
  invitedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});
export type InvitationView = z.infer<typeof InvitationView>;

/** `org.invitations.role` is stored Title-cased ('Admin'); the view model is the spec's lowercase enum. */
export function toOrgRole(stored: string): OrgRole | null {
  const parsed = OrgRole.safeParse(stored.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}
