"use client";
// Email verification (mockup `obVerify`). The design asks for a six-digit code;
// this deployment verifies by link (Better Auth `emailVerification`, no email
// OTP plugin, #3883), so the card holds what the link flow can do: say a spent link
// expired, and send a new one. The reply to a resend never reveals whether an
// account is waiting.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { resendVerification } from "./actions";
import {
  type AuthErrorKey,
  ResendVerificationSchema,
  fieldErrors,
} from "./schemas";
import { Field } from "@/ui/field";
import { SubmitButton } from "@/ui/form-feedback";
import { formText } from "./form-text";
import { AuthAlert, AuthPanel, authLinkButton } from "./ui/auth-card";

export function VerifyPanel({
  email,
  expired,
  next,
}: {
  email: string | null;
  expired: boolean;
  next: string;
}) {
  const t = useTranslations("auth");
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const parsed = ResendVerificationSchema.safeParse({
      email: formText(new FormData(event.currentTarget), "email"),
    });
    setSent(false);
    setUnavailable(false);
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).email ?? "emailInvalid");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await resendVerification({ ...parsed.data, next });
      if (result.ok) setSent(true);
      else setError(result.fields?.email ?? "emailInvalid");
    } catch {
      // A thrown action (network, server down) reads as unavailable, as on
      // the other sign-in forms, instead of an unhandled rejection.
      setUnavailable(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthPanel>
      {expired ? (
        <AuthAlert testId="verify-expired" message={t("verify.expired")} />
      ) : null}
      {unavailable ? (
        <AuthAlert
          testId="verify-outcome"
          message={t("outcomes.unavailable")}
        />
      ) : null}
      {sent ? (
        <p
          role="status"
          data-testid="verify-resent"
          className="rounded-[9px] border border-success/40 bg-success/10 px-3 py-2.5 text-[12.5px] text-foreground"
        >
          {t("verify.resent")}
        </p>
      ) : null}
      <form
        noValidate
        aria-label={t("verify.resend")}
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-3.5"
      >
        {email ? (
          <>
            <input type="hidden" name="email" value={email} />
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
              <span>{t("verify.notArrived")}</span>
              <button
                type="submit"
                aria-disabled={pending || undefined}
                data-touch-target=""
                className={authLinkButton}
              >
                {pending ? t("verify.resendPending") : t("verify.resend")}
              </button>
            </p>
            {error ? (
              <p className="text-sm text-error-ink">{t(`errors.${error}`)}</p>
            ) : null}
          </>
        ) : (
          <>
            <Field
              id="verify-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              label={t("fields.email")}
              error={error ? t(`errors.${error}`) : undefined}
            />
            <SubmitButton
              pending={pending}
              label={t("verify.resend")}
              pendingLabel={t("verify.resendPending")}
            />
          </>
        )}
      </form>
    </AuthPanel>
  );
}
