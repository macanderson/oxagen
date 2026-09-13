"use client";
// Email verification (mockup `obVerify` @ mc-baseline-w1). This deployment
// verifies by link (Better Auth `emailVerification`), not by six-digit code, so
// the screen says where the link went and offers a resend. The reply to a
// resend never reveals whether an account is waiting.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { resendVerification } from "./actions";
import { ResendVerificationSchema, fieldErrors } from "./schemas";
import { Field } from "./ui/field";
import { FormAlert, SubmitButton } from "./ui/feedback";
import { panel } from "./ui/styles";
import { formText } from "./form-text";

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
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const parsed = ResendVerificationSchema.safeParse({
      email: formText(new FormData(event.currentTarget), "email"),
    });
    setSent(false);
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
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      aria-label={t("verify.resend")}
      onSubmit={(e) => void onSubmit(e)}
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      {expired ? (
        <FormAlert testId="verify-expired">{t("verify.expired")}</FormAlert>
      ) : null}
      {sent ? (
        <p
          role="status"
          data-testid="verify-resent"
          className="rounded-lg border border-success/40 bg-success/10 px-3 py-2.5 text-sm text-foreground"
        >
          {t("verify.resent")}
        </p>
      ) : null}
      <h2 className="text-sm font-semibold text-foreground">
        {t("verify.resendTitle")}
      </h2>
      <Field
        id="verify-email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        defaultValue={email ?? ""}
        label={t("fields.email")}
        error={error ? t(`errors.${error}`) : undefined}
      />
      <SubmitButton
        pending={pending}
        label={t("verify.resend")}
        pendingLabel={t("verify.resendPending")}
      />
    </form>
  );
}
