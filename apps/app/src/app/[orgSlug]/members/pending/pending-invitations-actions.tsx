"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  declineInvitationAction,
  inviteMemberAction,
} from "@/app/[orgSlug]/members/actions";

// Roles the form supports — must match the InviteMemberSchema enum.
type OrgRole = "owner" | "admin" | "member" | "billing";

interface PendingInvitation {
  publicId: string;
  email: string;
  role: string;
}

interface PendingInvitationsActionsProps {
  orgSlug: string;
  invitation: PendingInvitation;
}

/**
 * Client component: Resend and Revoke buttons for a single pending invitation.
 *
 * Resend: calls inviteMemberAction (creates a new pending invitation row with
 * the same email+role — the old row stays pending until it expires or is revoked).
 * Revoke: calls declineInvitationAction (sets status='declined').
 */
export function PendingInvitationsActions({
  orgSlug,
  invitation,
}: PendingInvitationsActionsProps) {
  const [pending, startTransition] = React.useTransition();
  const { add: addToast } = useToast();

  // Guard: if role is not one of the four allowed values, default to "member"
  // so the type stays sound (DB could have historical values like "compliance").
  const safeRole: OrgRole = (
    ["owner", "admin", "member", "billing"] as const
  ).includes(invitation.role as OrgRole)
    ? (invitation.role as OrgRole)
    : "member";

  function handleResend() {
    startTransition(async () => {
      const res = await inviteMemberAction({
        orgSlug,
        email: invitation.email,
        role: safeRole,
      });
      if (res.ok) {
        addToast({
          title: "Invitation resent",
          description: `A new invitation was sent to ${invitation.email}.`,
          type: "success",
        });
      } else {
        const msg =
          "error" in res
            ? res.error
            : res.code === "seat_limit_reached"
              ? "No seats available. Upgrade your plan to invite more members."
              : "Failed to resend invitation.";
        addToast({
          title: "Failed to resend",
          description: msg,
          type: "error",
        });
      }
    });
  }

  function handleRevoke() {
    startTransition(async () => {
      const res = await declineInvitationAction({
        orgSlug,
        invitationPublicId: invitation.publicId,
      });
      if (res.ok) {
        addToast({
          title: "Invitation revoked",
          description: `Invitation for ${invitation.email} was revoked.`,
          type: "success",
        });
      } else {
        addToast({
          title: "Failed to revoke",
          description: res.error,
          type: "error",
        });
      }
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleResend}
        disabled={pending}
        aria-label={`Resend invitation to ${invitation.email}`}
      >
        Resend
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={handleRevoke}
        disabled={pending}
        aria-label={`Revoke invitation for ${invitation.email}`}
      >
        Revoke
      </Button>
    </>
  );
}
