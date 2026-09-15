"use client";
// Accept or decline, for the invited account (mockup `obInvite` @ mc-baseline-w1).

import { useTranslations } from "next-intl";
import { useState } from "react";
import { acceptInvitation, declineInvitation } from "./invite-actions";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { LoaderCircle } from "lucide-react";

export function InviteDecision({
  token,
  orgName,
}: {
  token: string;
  orgName: string;
}) {
  const t = useTranslations("auth.invite");
  const navigate = useNavigate();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [failed, setFailed] = useState(false);
  const [declined, setDeclined] = useState(false);

  async function run(kind: "accept" | "decline") {
    if (pending) return;
    setPending(kind);
    setFailed(false);
    try {
      const result =
        kind === "accept"
          ? await acceptInvitation(token)
          : await declineInvitation(token);
      if (!result.ok) {
        setFailed(true);
        return;
      }
      if (kind === "decline") {
        setDeclined(true);
        return;
      }
      navigate.replace(result.value.to);
    } catch {
      setFailed(true);
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
        {t("declined", { org: orgName })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <FormAlert testId="invite-failure">{t("failed")}</FormAlert>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonPrimary}
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
          className={buttonSecondary}
          aria-disabled={pending !== null || undefined}
          onClick={() => void run("decline")}
        >
          {pending === "decline" ? t("declining") : t("decline")}
        </button>
      </div>
    </div>
  );
}
