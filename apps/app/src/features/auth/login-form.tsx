"use client";
// Log in (mockup `obLogin` @ mc-baseline-w1). Validates in the browser, then
// signs in through Better Auth, or through the fixture action in fixture mode.
// The destination is the sanitised `next` the page passed down.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { signInFixture } from "./actions";
import type { AuthOutcomeKey } from "./auth-errors";
import { liveSignIn, rememberPendingNext } from "./client-auth";
import { withNext } from "./safe-next";
import { type FieldErrors, LoginSchema, fieldErrors } from "./schemas";
import { Field, PasswordField } from "./ui/field";
import { FormAlert, SubmitButton } from "./ui/feedback";
import { linkText, panel } from "./ui/styles";
import { formText } from "./form-text";

export type LoginFormProps = {
  next: string;
  fixture: boolean;
  initialOutcome?: AuthOutcomeKey | null;
};

export function LoginForm({
  next,
  fixture,
  initialOutcome = null,
}: LoginFormProps) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [errors, setErrors] = useState<FieldErrors<"email" | "password">>({});
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(initialOutcome);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const input = {
      email: formText(form, "email"),
      password: formText(form, "password"),
      rememberMe: form.get("rememberMe") === "on",
    };
    const parsed = LoginSchema.safeParse(input);
    setOutcome(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      if (fixture) {
        const result = await signInFixture({ ...parsed.data, next });
        if (!result.ok) {
          setErrors(result.fields ?? {});
          setOutcome(result.outcome ?? null);
          return;
        }
        router.replace(result.to);
        router.refresh();
        return;
      }
      rememberPendingNext(next);
      const result = await liveSignIn(parsed.data);
      if (!result.ok) {
        if (result.outcome === "emailNotVerified") {
          router.push(
            withNext(
              `/verify?email=${encodeURIComponent(parsed.data.email)}`,
              next,
            ),
          );
          return;
        }
        setOutcome(result.outcome);
        return;
      }
      router.replace(result.twoFactor ? withNext("/two-factor", next) : next);
      router.refresh();
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      aria-label={t("login.title")}
      onSubmit={(e) => void onSubmit(e)}
      className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
    >
      {outcome ? (
        <FormAlert testId="login-outcome">{t(`outcomes.${outcome}`)}</FormAlert>
      ) : null}
      <Field
        id="login-email"
        name="email"
        type="email"
        autoComplete="username"
        inputMode="email"
        label={t("fields.email")}
        error={errors.email ? t(`errors.${errors.email}`) : undefined}
      />
      <PasswordField
        id="login-password"
        name="password"
        autoComplete="current-password"
        label={t("fields.password")}
        showLabel={t("fields.showPassword")}
        hideLabel={t("fields.hidePassword")}
        labelAside={
          <Link href="/forgot-password" className={`${linkText} text-xs`}>
            {t("login.forgot")}
          </Link>
        }
        error={errors.password ? t(`errors.${errors.password}`) : undefined}
      />
      <label className="flex items-start gap-2.5 text-sm text-foreground">
        <input
          type="checkbox"
          name="rememberMe"
          defaultChecked
          className="mt-0.5 size-4 accent-primary"
        />
        <span>{t("fields.rememberMe")}</span>
      </label>
      <SubmitButton
        pending={pending}
        label={t("login.submit")}
        pendingLabel={t("login.pending")}
      />
    </form>
  );
}
