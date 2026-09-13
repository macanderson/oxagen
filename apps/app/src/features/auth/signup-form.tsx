"use client";
// Create an account (mockup `obSignup` @ mc-baseline-w1). A new account goes to
// email verification when the deployment requires it, otherwise straight into
// the onboarding gate.
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { signUpFixture } from "./actions";
import type { AuthOutcomeKey } from "./auth-errors";
import { liveSignUp } from "./client-auth";
import { AFTER_SIGNUP } from "./routes";
import {
  type FieldErrors,
  PASSWORD_MIN,
  SignupSchema,
  fieldErrors,
} from "./schemas";
import { Field, PasswordField } from "./ui/field";
import { FormAlert, SubmitButton } from "./ui/feedback";
import { panel } from "./ui/styles";

type SignupField = "name" | "email" | "password";

export function SignupForm({ fixture }: { fixture: boolean }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors<SignupField>>({});
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = SignupSchema.safeParse({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setOutcome(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      if (fixture) {
        const result = await signUpFixture(parsed.data);
        if (!result.ok) {
          setErrors(result.fields ?? {});
          setOutcome(result.outcome ?? null);
          return;
        }
        router.replace(result.to as Route);
        router.refresh();
        return;
      }
      const result = await liveSignUp(parsed.data);
      if (!result.ok) {
        setOutcome(result.outcome);
        return;
      }
      router.replace(
        (result.needsVerification
          ? `/verify?email=${encodeURIComponent(parsed.data.email)}`
          : AFTER_SIGNUP) as Route,
      );
      router.refresh();
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  const message = (key: string | undefined) =>
    key ? t(`errors.${key}`) : undefined;

  return (
    <form
      noValidate
      aria-label={t("signup.submit")}
      onSubmit={(e) => void onSubmit(e)}
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      {outcome ? (
        <FormAlert testId="signup-outcome">
          {t(`outcomes.${outcome}`)}
        </FormAlert>
      ) : null}
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
        label={t("fields.email")}
        error={message(errors.email)}
      />
      <PasswordField
        id="signup-password"
        name="password"
        autoComplete="new-password"
        label={t("fields.password")}
        hint={t("fields.passwordHint", { min: PASSWORD_MIN })}
        showLabel={t("fields.showPassword")}
        hideLabel={t("fields.hidePassword")}
        error={message(errors.password)}
      />
      <SubmitButton
        pending={pending}
        label={t("signup.submit")}
        pendingLabel={t("signup.pending")}
      />
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("signup.terms")}
      </p>
    </form>
  );
}
