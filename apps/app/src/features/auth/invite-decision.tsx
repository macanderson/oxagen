"use client";
// Accept or decline, for the invited account (mockup `obInvite` @ mc-baseline-w1).
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  type InviteActionResult,
  acceptInvitation,
  declineInvitation,
} from "./invite-actions";
import { FormAlert } from "./ui/feedback";
import { buttonPrimary, buttonSecondary } from "./ui/styles";
import { LoaderCircle } from "lucide-react";

type Failure = Extract<InviteActionResult, { ok: false }>["reason"];

export function InviteDecision({
  token,
  orgName,
}: {
  token: string;
  orgName: string;
}) {
  const t = useTranslations("auth.invite");
  const router = useRouter();
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [declined, setDeclined] = useState(false);

  async function run(kind: "accept" | "decline") {
    if (pending) return;
    setPending(kind);
    setFailure(null);
    try {
      const result =
        kind === "accept"
          ? await acceptInvitation(token)
          : await declineInvitation(token);
      if (!result.ok) {
        setFailure(result.reason);
        return;
      }
      if (kind === "decline") {
        setDeclined(true);
        return;
      }
      router.replace(result.to as Route);
      router.refresh();
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
        {t("declined", { org: orgName })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {failure ? (
        <FormAlert testId="invite-failure">
          {failure === "fixture" ? t("unavailable") : t("failed")}
        </FormAlert>
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
