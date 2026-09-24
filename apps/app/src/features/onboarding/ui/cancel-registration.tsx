"use client";
// Cancel on every register step (register-name spec, Functionality): before
// the name step reserves the key, nothing exists, so Cancel is a link back to
// Fleet. Once the identity exists it retires it (`retire_agent`), which revokes
// its credential, every host enrollment and every mandate in one write, and
// then opens Fleet. A refusal keeps the operator on the step and says why.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { cancelRegistration } from "../register-actions";

export function CancelRegistration({
  org,
  ws,
  agentId,
  fleet,
  className = "",
  testId,
}: {
  org: string;
  ws: string;
  /** The identity the name step minted; null before it exists. */
  agentId: string | null;
  fleet: SafePath;
  className?: string;
  testId: string;
}) {
  const t = useTranslations("onboarding.register");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (agentId === null) {
    return (
      <SafeLink
        to={fleet}
        data-testid={testId}
        className={`${buttonSecondary} ${className}`}
      >
        {t("cancel")}
      </SafeLink>
    );
  }

  async function cancel(id: string) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await cancelRegistration(org, ws, id);
      if (result.ok) navigate.push(result.value.to);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <span className={`inline-flex flex-col gap-1 ${className}`}>
      <button
        type="button"
        data-testid={testId}
        disabled={pending}
        onClick={() => void cancel(agentId)}
        className={`${buttonSecondary} w-full`}
      >
        {pending ? t("cancelling") : t("cancel")}
      </button>
      {failure === null ? null : (
        <span role="alert" className="max-w-xs text-xs text-error-ink">
          {failure}
        </span>
      )}
    </span>
  );
}
