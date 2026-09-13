// The invitation a person opens at /invite/[token], as the page needs it. Enums
// follow spec App. A (`org.org_users.role`) and the live `org.invitations.status`
// check constraint. Promote: OrgRole and InvitationView belong in
// src/data/contracts once lane L1's org contracts land.
import { z } from "zod";

export const OrgRole = z.enum([
  "owner",
  "admin",
  "member",
  "billing",
  "compliance",
  "viewer",
]);
export type OrgRole = z.infer<typeof OrgRole>;

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

export type InvitationDecision =
  | { kind: "accept" }
  | { kind: "sign-in" }
  | { kind: "wrong-account"; signedInAs: string }
  | { kind: "closed"; status: Exclude<InvitationStatus, "pending"> };

/**
 * What the invite page offers. A pending invitation past its expiry is closed as
 * `expired` even when the row still says pending (nothing sweeps them).
 */
export function decideInvitation(
  invitation: InvitationView,
  viewerEmail: string | null,
  now: Date = new Date(),
): InvitationDecision {
  if (invitation.status !== "pending")
    return { kind: "closed", status: invitation.status };
  if (
    invitation.expiresAt !== null &&
    new Date(invitation.expiresAt).getTime() <= now.getTime()
  ) {
    return { kind: "closed", status: "expired" };
  }
  if (viewerEmail === null) return { kind: "sign-in" };
  if (
    viewerEmail.trim().toLowerCase() !== invitation.email.trim().toLowerCase()
  ) {
    return { kind: "wrong-account", signedInAs: viewerEmail };
  }
  return { kind: "accept" };
}
