"use client";
/**
 * revoke-own-session-button.tsx — lets a user revoke one of their own other
 * sessions from the account/security page. No org scope — user can always
 * manage their own sessions.
 */

import * as React from "react";
import { CircleSlash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revokeOwnSessionAction } from "../actions";

export interface RevokeOwnSessionButtonProps {
  sessionId: string;
}

export function RevokeOwnSessionButton({
  sessionId,
}: RevokeOwnSessionButtonProps) {
  const [status, setStatus] = React.useState<
    "idle" | "confirming" | "revoking" | "error"
  >("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  async function handleRevoke() {
    if (status === "revoking") return;
    if (status !== "confirming") {
      setStatus("confirming");
      return;
    }
    setStatus("revoking");
    setErrorMsg(null);
    const result = await revokeOwnSessionAction({ sessionId });
    if (!result.ok) {
      setStatus("error");
      setErrorMsg(
        "error" in result ? result.error : "Failed to revoke session.",
      );
    }
    // On success the page re-renders via revalidatePath; the row disappears.
  }

  if (status === "confirming") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Revoke?</span>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleRevoke}
          className="h-7 px-2.5 text-xs"
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStatus("idle")}
          className="h-7 px-2.5 text-xs"
        >
          Cancel
        </Button>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-destructive">{errorMsg}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setStatus("idle")}
          className="h-7 px-2.5 text-xs"
        >
          Dismiss
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleRevoke}
      className="h-7 px-2.5 text-xs text-muted-foreground hover:text-destructive"
      title="Revoke this session"
    >
      <CircleSlash className="mr-1 h-3 w-3" aria-hidden="true" />
      Revoke
    </Button>
  );
}
