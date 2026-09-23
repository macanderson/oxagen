"use client";
// Accept or decline, for the invited account (mockup `obInvite`). Declining
// changes the invitation and nothing else: no one is notified today.

import { useTranslations } from "next-intl";
import { useState } from "react";
import { acceptInvitation, declineInvitation } from "./invite-actions";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { LoaderCircle } from "lucide-react";

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

  async function run(kind: "accept" | "decline") {
    if (pending) return;
    setPending(kind);
    setFailure(null);
    try {
      if (kind === "accept") {
        const result = await acceptInvitation(token);
        if (result.ok) navigate.replace(result.value.to);
        else setFailure(failureOf(result.reason));
      } else {
        const result = await declineInvitation(token);
        if (result.ok) setDeclined(true);
        else setFailure(failureOf(result.reason));
      }
    } catch {
      setFailure("failed");
    } finally {
      setPending(null);
    }
  }

  if (declined) {
    return (
      <p
        role="status"
        data-testid="invite-declined"
        className="text-sm text-muted-foreground"
      >
        {t("declined")}
      </p>
    );
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
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-touch-target=""
          className={`${buttonPrimary} max-md:flex-1`}
          aria-disabled={pending !== null || undefined}
          onClick={() => void run("accept")}
        >
          {pending === "accept" ? (
            <LoaderCircle
              aria-hidden
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : null}
          {pending === "accept" ? t("accepting") : t("accept")}
        </button>
        <button
          type="button"
          data-touch-target=""
          className={`${buttonSecondary} max-md:flex-1`}
          aria-disabled={pending !== null || undefined}
          onClick={() => void run("decline")}
        >
          {pending === "decline" ? t("declining") : t("decline")}
        </button>
      </div>
    </div>
  );
}
