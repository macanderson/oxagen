"use client";
/**
 * review-row-actions.tsx — per-member Confirm / Revoke actions in the
 * access review table. Confirm = CC6.3 evidence (no change to access).
 * Revoke = removes the member (owner/admin only).
 */

import * as React from "react";
import { CheckCircle2, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  confirmMemberAccessAction,
  revokeMemberAccessAction,
} from "../actions";

export interface ReviewRowActionsProps {
  orgSlug: string;
  targetUserId: string;
  targetUserName: string;
  /** Whether the current user can revoke (owner/admin only). */
  canRevoke: boolean;
  /** Whether this row is the current user — disables revoke. */
  isSelf: boolean;
}

type ActionStatus =
  | "idle"
  | "confirming_revoke"
  | "working"
  | "confirmed"
  | "revoked"
  | "error";

export function ReviewRowActions({
  orgSlug,
  targetUserId,
  targetUserName,
  canRevoke,
  isSelf,
}: ReviewRowActionsProps) {
  const [status, setStatus] = React.useState<ActionStatus>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  async function handleConfirm() {
    if (status === "working") return;
    setStatus("working");
    setErrorMsg(null);
    const result = await confirmMemberAccessAction({ orgSlug, targetUserId });
    if (result.ok) {
      setStatus("confirmed");
    } else {
      setStatus("error");
      setErrorMsg("Permission denied");
    }
  }

  async function handleRevoke() {
    if (status === "working") return;
    if (status !== "confirming_revoke") {
      setStatus("confirming_revoke");
      return;
    }
    setStatus("working");
    setErrorMsg(null);
    const result = await revokeMemberAccessAction({ orgSlug, targetUserId });
    if (result.ok) {
      setStatus("revoked");
    } else {
      setStatus("error");
      setErrorMsg(
        result.code === "self_action"
          ? "Cannot revoke your own access."
          : result.code === "forbidden"
            ? "Owner or admin role required."
            : "Member not found or already removed.",
      );
    }
  }

  if (status === "confirmed") {
    return (
      <Badge variant="success" className="text-xs">
        Confirmed
      </Badge>
    );
  }

  if (status === "revoked") {
    return (
      <Badge variant="muted" className="text-xs">
        Revoked
      </Badge>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-destructive">{errorMsg}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setStatus("idle");
            setErrorMsg(null);
          }}
          className="h-6 px-2 text-xs"
        >
          Dismiss
        </Button>
      </div>
    );
  }

  if (status === "confirming_revoke") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">
          Remove {targetUserName}?
        </span>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleRevoke}
          className="h-6 px-2 text-xs"
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStatus("idle")}
          className="h-6 px-2 text-xs"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={handleConfirm}
        disabled={status === "working" || isSelf}
        className="h-7 px-2.5 text-xs text-muted-foreground hover:text-[hsl(142_71%_45%)]"
        title="Confirm access is appropriate"
      >
        <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
        Confirm
      </Button>
      {canRevoke && !isSelf && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleRevoke}
          disabled={status === "working"}
          className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
          title="Remove member's access"
        >
          <UserMinus className="mr-1 h-3 w-3" aria-hidden="true" />
          Revoke
        </Button>
      )}
      {isSelf && (
        <Badge variant="muted" className="text-[10px]">
          You
        </Badge>
      )}
    </div>
  );
}
