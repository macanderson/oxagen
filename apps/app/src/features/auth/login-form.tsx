"use client";
// Log in (mockup `obLogin` @ mc-baseline-w1). Validates in the browser, then
// signs in through Better Auth. The destination is the sanitised `next` the
// page passed down, and the SSO entry above the password form sends a single
// sign-on to the same place.
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { AuthOutcomeKey } from "./auth-errors";
import { liveSignIn, rememberPendingNext } from "./auth-client";
import { routes, type SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { type FieldErrors, LoginSchema, fieldErrors } from "./schemas";
import { Field, PasswordField } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { linkText, panel } from "@/ui/control-styles";
import { formText } from "./form-text";
import { SsoSignIn } from "./ui/sso-sign-in";

export type LoginFormProps = {
  next: SafePath;
  initialOutcome?: AuthOutcomeKey | null;
  /**
   * `?sso=required`: requireViewer sent the person here because their
   * organization requires SSO.
   */
  ssoRequired?: boolean;
};

/** Outcomes that belong to the SSO entry rather than the password form. */
const SSO_OUTCOMES: ReadonlySet<AuthOutcomeKey> = new Set([
  "ssoNoProvider",
  "ssoDomainUnverified",
  "ssoFailed",
]);

export function LoginForm({
  next,
  initialOutcome = null,
  ssoRequired = false,
}: LoginFormProps) {
  const t = useTranslations("auth");
  const navigate = useNavigate();
  const initialSso =
    initialOutcome !== null && SSO_OUTCOMES.has(initialOutcome)
      ? initialOutcome
      : null;
  const [errors, setErrors] = useState<FieldErrors<"email" | "password">>({});
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(
    initialSso === null ? initialOutcome : null,
  );
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
      rememberPendingNext(next);
      const result = await liveSignIn(parsed.data);
      if (!result.ok) {
        if (result.outcome === "emailNotVerified") {
          navigate.push(routes.verify({ email: parsed.data.email, next }));
          return;
        }
        setOutcome(result.outcome);
        return;
      }
      navigate.replace(result.twoFactor ? routes.twoFactor(next) : next);
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  // A password refused because the organization requires SSO opens the SSO
  // entry too; the key remounts it so it starts open.
  const ssoOpen = ssoRequired || outcome === "ssoRequired";

  return (
    <div className="flex flex-col gap-4">
      <SsoSignIn
        key={ssoOpen ? "open" : "closed"}
        callbackURL={next}
        required={ssoRequired}
        initialOutcome={initialSso}
        startOpen={ssoOpen}
      />
      <form
        noValidate
        aria-label={t("login.title")}
        onSubmit={(e) => void onSubmit(e)}
        className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
      >
        {outcome ? (
          <FormAlert testId="login-outcome">
            {t(`outcomes.${outcome}`)}
          </FormAlert>
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
    </div>
  );
}
