"use client";
// Forgot password and set a new password (mockups `obForgot`, `obReset`). The
// request never says whether an account exists. Each form takes the page's
// header and footer, because its full-card states (link sent, link expired)
// replace the header the way the design does.
import { Inbox, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, type SyntheticEvent, useState } from "react";
import { requestPasswordReset, resetPassword } from "./actions";
import type { AuthOutcomeKey } from "./auth-errors";
import { rememberNotice } from "./auth-client";
import {
  type AuthErrorKey,
  type FieldErrors,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  fieldErrors,
} from "./schemas";
import { routes } from "@/shared/safe-path";
import { Field, PasswordField } from "@/ui/field";
import { OutcomePanel, SubmitButton } from "@/ui/form-feedback";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { formText } from "./form-text";
import { AuthAlert, AuthPanel } from "./ui/auth-card";
import { PasswordStrength } from "./ui/password-strength";

type Frame = { header?: ReactNode; footer?: ReactNode };

export function ForgotPasswordForm({ header = null, footer = null }: Frame) {
  const t = useTranslations("auth");
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [failed, setFailed] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const parsed = ForgotPasswordSchema.safeParse({
      email: formText(new FormData(event.currentTarget), "email"),
    });
    setFailed(false);
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
      setFailed(true);
    } finally {
      setPending(false);
    }
  }

  if (sentTo !== null) {
    return (
      <>
        <OutcomePanel
          tone="neutral"
          testId="forgot-sent"
          title={t("forgot.sentTitle")}
          icon={<Inbox aria-hidden className="size-5" />}
        >
          {t.rich("forgot.sentBody", {
            email: sentTo,
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </OutcomePanel>
        {footer}
      </>
    );
  }

  return (
    <>
      {header}
      <AuthPanel>
        {failed ? (
          <AuthAlert testId="forgot-failed" message={t("forgot.failed")} />
        ) : null}
        <form
          noValidate
          aria-label={t("forgot.title")}
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-3.5"
        >
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
      </AuthPanel>
      {footer}
    </>
  );
}

type ResetField = "newPassword" | "confirmPassword";

const NEW_PASSWORD_ID = "reset-new-password";
const REQUIREMENTS_ID = `${NEW_PASSWORD_ID}-requirements`;

export function ResetPasswordForm({
  token,
  header = null,
}: {
  token: string;
  header?: ReactNode;
}) {
  const t = useTranslations("auth");
  const navigate = useNavigate();
  const [errors, setErrors] = useState<FieldErrors<ResetField>>({});
  const [expired, setExpired] = useState(token === "");
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");

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
      if (result.ok) {
        // Log in shows "Password set. Every other device was logged out." once.
        rememberNotice("passwordSet");
        navigate.replace(routes.login());
        return;
      }
      if (result.outcome === "linkExpired") setExpired(true);
      else if (result.fields) setErrors(result.fields);
      else setOutcome(result.outcome ?? "unknown");
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  if (expired) {
    return (
      <OutcomePanel
        tone="deny"
        testId="reset-expired"
        title={t("reset.expiredTitle")}
        icon={<TriangleAlert aria-hidden className="size-5" />}
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

  const message = (key: AuthErrorKey | undefined) =>
    key ? t(`errors.${key}`) : undefined;
  // A mismatch is the card's alert, with the confirmation marked; every other
  // field error sits under its field.
  const mismatch = errors.confirmPassword === "passwordsDiffer";
  const newPasswordError = message(errors.newPassword);
  return (
    <>
      {header}
      <AuthPanel>
        {mismatch ? (
          <AuthAlert
            testId="reset-mismatch"
            message={t("errors.passwordsDiffer")}
          />
        ) : null}
        {outcome ? (
          <AuthAlert
            testId="reset-outcome"
            message={t(`outcomes.${outcome}`)}
          />
        ) : null}
        <form
          noValidate
          aria-label={t("reset.title")}
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-3.5"
        >
          <div className="flex flex-col gap-2">
            <PasswordField
              id={NEW_PASSWORD_ID}
              name="newPassword"
              autoComplete="new-password"
              label={t("fields.newPassword")}
              showLabel={t("fields.showPassword")}
              hideLabel={t("fields.hidePassword")}
              error={newPasswordError}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              aria-describedby={
                newPasswordError
                  ? `${NEW_PASSWORD_ID}-error ${REQUIREMENTS_ID}`
                  : REQUIREMENTS_ID
              }
            />
            <PasswordStrength id={REQUIREMENTS_ID} value={password} />
          </div>
          <Field
            id="reset-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            label={t("fields.confirmPassword")}
            error={mismatch ? undefined : message(errors.confirmPassword)}
            aria-invalid={errors.confirmPassword ? true : undefined}
          />
          <SubmitButton
            pending={pending}
            label={t("reset.submit")}
            pendingLabel={t("reset.pending")}
          />
        </form>
      </AuthPanel>
    </>
  );
}
