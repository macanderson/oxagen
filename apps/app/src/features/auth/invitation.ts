// What the invite page offers for one invitation. The view model and its enums
// live in src/data/contracts/invitations.ts.
import type {
  InvitationStatus,
  InvitationView,
} from "@/data/contracts/invitations";

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
