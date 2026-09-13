"use client";
// Forgot password and set a new password (mockup `obForgot`/`obReset` @
// mc-baseline-w1). The request never says whether an account exists.
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { requestPasswordReset, resetPassword } from "./actions";
import type { AuthOutcomeKey } from "./auth-errors";
import {
  type FieldErrors,
  ForgotPasswordSchema,
  PASSWORD_MIN,
  ResetPasswordSchema,
  fieldErrors,
} from "./schemas";
import { Field, PasswordField } from "@/ui/field";
import { FormAlert, OutcomePanel, SubmitButton } from "@/ui/form-feedback";
import { buttonPrimary, buttonSecondary, panel } from "@/ui/control-styles";
import { formText } from "./form-text";

export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const parsed = ForgotPasswordSchema.safeParse({
      email: formText(new FormData(event.currentTarget), "email"),
    });
    setOutcome(null);
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).email ?? "emailInvalid");
      return;
    }
    setError(null);
    setPending(true);
    try {
      const result = await requestPasswordReset(parsed.data);
      if (result.ok) setSentTo(parsed.data.email);
      else setError(result.fields?.email ?? "emailInvalid");
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  if (sentTo !== null) {
    return (
      <OutcomePanel
        tone="ok"
        testId="forgot-sent"
        title={t("forgot.sentTitle")}
        actions={
          <button
            type="button"
            className={buttonSecondary}
            onClick={() => {
              setSentTo(null);
            }}
          >
            {t("forgot.again")}
          </button>
        }
      >
        {t("forgot.sentBody", { email: sentTo })}
      </OutcomePanel>
    );
  }

  return (
    <form
      noValidate
      aria-label={t("forgot.title")}
      onSubmit={(e) => void onSubmit(e)}
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      {outcome ? <FormAlert>{t(`outcomes.${outcome}`)}</FormAlert> : null}
      <Field
        id="forgot-email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        label={t("fields.email")}
        error={error ? t(`errors.${error}`) : undefined}
      />
      <SubmitButton
        pending={pending}
        label={t("forgot.submit")}
        pendingLabel={t("forgot.pending")}
      />
    </form>
  );
}

type ResetField = "newPassword" | "confirmPassword";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [errors, setErrors] = useState<FieldErrors<ResetField>>({});
  const [state, setState] = useState<"form" | "done" | "expired">(
    token ? "form" : "expired",
  );
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = ResetPasswordSchema.safeParse({
      token,
      newPassword: formText(form, "newPassword"),
      confirmPassword: formText(form, "confirmPassword"),
    });
    setOutcome(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await resetPassword(parsed.data);
      if (result.ok) setState("done");
      else if (result.outcome === "linkExpired") setState("expired");
      else if (result.fields) setErrors(result.fields);
      else setOutcome(result.outcome ?? "unknown");
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  if (state === "expired") {
    return (
      <OutcomePanel
        tone="deny"
        testId="reset-expired"
        title={t("reset.expiredTitle")}
        actions={
          <Link href="/forgot-password" className={buttonSecondary}>
            {t("reset.requestNew")}
          </Link>
        }
      >
        {t("reset.expiredBody")}
      </OutcomePanel>
    );
  }

  if (state === "done") {
    return (
      <OutcomePanel
        tone="ok"
        testId="reset-done"
        title={t("reset.doneTitle")}
        actions={
          <Link href="/login" className={buttonPrimary}>
            {t("reset.logIn")}
          </Link>
        }
      >
        {t("reset.doneBody")}
      </OutcomePanel>
    );
  }

  const message = (key: string | undefined) =>
    key ? t(`errors.${key}`) : undefined;
  return (
    <form
      noValidate
      aria-label={t("reset.title")}
      onSubmit={(e) => void onSubmit(e)}
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      {outcome ? <FormAlert>{t(`outcomes.${outcome}`)}</FormAlert> : null}
      <PasswordField
        id="reset-new-password"
        name="newPassword"
        autoComplete="new-password"
        label={t("fields.newPassword")}
        hint={t("fields.passwordHint", { min: PASSWORD_MIN })}
        showLabel={t("fields.showPassword")}
        hideLabel={t("fields.hidePassword")}
        error={message(errors.newPassword)}
      />
      <Field
        id="reset-confirm-password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        label={t("fields.confirmPassword")}
        error={message(errors.confirmPassword)}
      />
      <SubmitButton
        pending={pending}
        label={t("reset.submit")}
        pendingLabel={t("reset.pending")}
      />
    </form>
  );
}
