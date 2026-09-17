"use client";
/**
 * revoke-session-button.tsx — confirm + revoke for a single session row.
 *
 * Uses a native <dialog>-style confirm to avoid RSC/client boundary pain.
 * The actual mutation goes through revokeSessionAction (server action).
 */

import * as React from "react";
import { CircleSlash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { revokeSessionAction, type RevokeSessionInput } from "../actions";

export interface RevokeSessionButtonProps {
  orgSlug: string;
  sessionId: string;
  targetUserId: string;
  /** Display name of the user — used in the confirm message. */
  userName: string;
}

export function RevokeSessionButton({
  orgSlug,
  sessionId,
  targetUserId,
  userName,
}: RevokeSessionButtonProps) {
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
    const input: RevokeSessionInput = { orgSlug, sessionId, targetUserId };
    const result = await revokeSessionAction(input);
    if (result.ok) {
      // Page will re-render via revalidatePath — button disappears.
    } else {
      setStatus("error");
      setErrorMsg(
        "error" in result
          ? result.error
          : result.code === "forbidden"
            ? "Owner or admin role required."
            : "Session not found or already revoked.",
      );
    }
  }

  if (status === "confirming") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Revoke {userName}?
        </span>
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
      <div className="flex items-center gap-2">
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
      title="Revoke session"
    >
      <CircleSlash className="mr-1 h-3 w-3" aria-hidden="true" />
      Revoke
    </Button>
  );
}
