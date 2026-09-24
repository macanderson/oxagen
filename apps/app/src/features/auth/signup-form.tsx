"use client";
// Create an account (mockup `obSignup`). One card: the refusal, Google and
// GitHub, the "or" rule, then name, work email and a password with its meter
// and requirement list, the submit and the terms line. A new account goes to
// email verification when the deployment requires it, otherwise straight to
// creating its organization. An address handed back by Verify email's Change
// it fills the email field, which stays editable.

import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { AuthOutcomeKey } from "./auth-errors";
import { liveSignUp } from "./auth-client";
import { AFTER_SIGNUP } from "./routes";
import { routes, type SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import {
  type AuthErrorKey,
  type FieldErrors,
  SignupSchema,
  fieldErrors,
} from "./schemas";
import { Field, PasswordField } from "@/ui/field";
import { SubmitButton } from "@/ui/form-feedback";
import { formText } from "./form-text";
import { AuthAlert, AuthPanel } from "./ui/auth-card";
import { OAuthButtons } from "./ui/oauth-buttons";
import { PasswordStrength } from "./ui/password-strength";

type SignupField = "name" | "email" | "password";

const PASSWORD_ID = "signup-password";
const REQUIREMENTS_ID = `${PASSWORD_ID}-requirements`;

export function SignupForm({
  next = AFTER_SIGNUP,
  email = null,
}: {
  next?: SafePath;
  /** The address to start from, already checked for shape (`queryEmail`). */
  email?: string | null;
}) {
  const t = useTranslations("auth");
  const navigate = useNavigate();
  const [errors, setErrors] = useState<FieldErrors<SignupField>>({});
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState("");

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = SignupSchema.safeParse({
      name: formText(form, "name"),
      email: formText(form, "email"),
      password: formText(form, "password"),
    });
    setOutcome(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await liveSignUp(parsed.data);
      if (!result.ok) {
        setOutcome(result.outcome);
        return;
      }
      navigate.replace(
        result.needsVerification
          ? routes.verify({ email: parsed.data.email, next })
          : next,
      );
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  const message = (key: AuthErrorKey | undefined) =>
    key ? t(`errors.${key}`) : undefined;
  const passwordError = message(errors.password);

  return (
    <AuthPanel>
      {outcome ? (
        <AuthAlert testId="signup-outcome" message={t(`outcomes.${outcome}`)} />
      ) : null}
      <OAuthButtons callbackURL={next} />
      <form
        noValidate
        aria-label={t("signup.submit")}
        onSubmit={(e) => void onSubmit(e)}
        className="flex flex-col gap-3.5"
      >
        <Field
          id="signup-name"
          name="name"
          type="text"
          autoComplete="name"
          label={t("fields.name")}
          error={message(errors.name)}
        />
        <Field
          id="signup-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          defaultValue={email ?? undefined}
          label={t("fields.email")}
          error={message(errors.email)}
          // A registered address marks the field; the alert above says why.
          aria-invalid={
            errors.email !== undefined || outcome === "alreadyRegistered"
              ? true
              : undefined
          }
        />
        <div className="flex flex-col gap-2">
          <PasswordField
            id={PASSWORD_ID}
            name="password"
            autoComplete="new-password"
            label={t("fields.password")}
            showLabel={t("fields.showPassword")}
            hideLabel={t("fields.hidePassword")}
            error={passwordError}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
            aria-describedby={
              passwordError
                ? `${PASSWORD_ID}-error ${REQUIREMENTS_ID}`
                : REQUIREMENTS_ID
            }
          />
          <PasswordStrength id={REQUIREMENTS_ID} value={password} />
        </div>
        <SubmitButton
          pending={pending}
          label={t("signup.submit")}
          pendingLabel={t("signup.pending")}
        />
        <p className="text-xs leading-relaxed text-dim">{t("signup.terms")}</p>
      </form>
    </AuthPanel>
  );
}
