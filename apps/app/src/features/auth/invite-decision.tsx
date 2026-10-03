"use client";
// Accept or decline, for the invited account (mockup `obInvite`). Declining
// changes the invitation and nothing else: no one is notified today (#3886).
// The decline is confirmed by a toast, as the design's `act()` does, and the
// two buttons stay in place, now inert, so focus stays on Decline.

import { useTranslations } from "next-intl";
import { useState } from "react";
import { rememberSignedIn } from "./auth-client";
import { acceptInvitation, declineInvitation } from "./invite-actions";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import { CircleNotchIcon } from "@phosphor-icons/react";

/** The refusal the alert names: another account, a closed invitation, or any other failure. */
type Failure = "denied" | "closed" | "failed";

const failureOf = (reason: string): Failure =>
  reason === "denied" ? "denied" : reason === "conflict" ? "closed" : "failed";

export function InviteDecision({ token }: { token: string }) {
  const t = useTranslations("auth.invite");
  const navigate = useNavigate();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [declined, setDeclined] = useState(false);
  // Pressing either button does nothing while one is running or once declined.
  const inert = pending !== null || declined;

  async function run(kind: "accept" | "decline") {
    if (inert) return;
    setPending(kind);
    setFailure(null);
    try {
      if (kind === "accept") {
        const result = await acceptInvitation(token);
        if (result.ok) {
          // Fleet shows "Signed in as …" once (SignedInToast), as the design does.
          rememberSignedIn();
          navigate.replace(result.value.to);
        } else setFailure(failureOf(result.reason));
      } else {
        const result = await declineInvitation(token);
        if (result.ok) {
          setDeclined(true);
          toast(t("declined"));
        } else setFailure(failureOf(result.reason));
      }
    } catch {
      setFailure("failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {failure ? (
        <FormAlert testId="invite-failure">
          {failure === "denied"
            ? t("denied")
            : failure === "closed"
              ? t("failedClosed")
              : t("failed")}
        </FormAlert>
      ) : null}
      {/* Below md the two buttons stack, each full width (accept-invitation.md, Mobile). */}
      <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
        <Button
          type="button"
          data-touch-target=""
          variant="primary" className="max-md:w-full"
          aria-disabled={inert || undefined}
          onClick={() => void run("accept")}
        >
          {pending === "accept" ? (
            <CircleNotchIcon
              aria-hidden
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {pending === "accept" ? t("accepting") : t("accept")}
        </Button>
        <Button
          type="button"
          data-touch-target=""
          variant="outline" className="max-md:w-full"
          aria-disabled={inert || undefined}
          onClick={() => void run("decline")}
        >
          {pending === "decline" ? t("declining") : t("decline")}
        </Button>
      </div>
    </div>
  );
}
