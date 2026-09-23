"use client";
// Log in (mockup `obLogin`). The page hands over its header and footer so the
// suspended state can replace all three with one full card, the way the design
// does (who suspended the account, and when, is not recorded yet: #3885).
// Validates in the browser, then signs in through Better Auth. The
// destination is the sanitised `next` the page passed down, and the SSO entry
// under the two providers sends a single sign-on to the same place.
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  type SyntheticEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AuthOutcomeKey } from "./auth-errors";
import {
  type AuthNotice,
  liveSignIn,
  rememberPendingEmail,
  rememberPendingNext,
  takeNotice,
} from "./auth-client";
import { routes, type SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { type FieldErrors, LoginSchema, fieldErrors } from "./schemas";
import { Field, PasswordField } from "@/ui/field";
import { OutcomePanel, SubmitButton } from "@/ui/form-feedback";
import { linkText, mono } from "@/ui/control-styles";
import { formText } from "./form-text";
import { AuthAlert, AuthPanel } from "./ui/auth-card";
import { OAuthButtons } from "./ui/oauth-buttons";
import { SsoSignIn } from "./ui/sso-sign-in";

export type LoginFormProps = {
  next: SafePath;
  initialOutcome?: AuthOutcomeKey | null;
  /**
   * `?sso=required`: requireViewer sent the person here because their
   * organization requires SSO.
   */
  ssoRequired?: boolean;
  /** The page's header; the suspended state replaces it. */
  header?: ReactNode;
  /** The page's footer; the suspended state replaces it. */
  footer?: ReactNode;
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
  header = null,
  footer = null,
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
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<AuthNotice | null>(null);

  // A notice another screen left (a password just set) shows once, after
  // hydration; the ref keeps a development double-run from taking it twice.
  const took = useRef(false);
  useEffect(() => {
    if (took.current) return;
    took.current = true;
    setNotice(takeNotice());
  }, []);

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
    setNotice(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setEmail(parsed.data.email);
    setPending(true);
    try {
      rememberPendingNext(next);
      rememberPendingEmail(parsed.data.email);
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

  if (outcome === "suspended") {
    return (
      <OutcomePanel
        tone="deny"
        testId="login-suspended"
        title={t("login.suspendedTitle")}
      >
        {email
          ? t.rich("login.suspendedBody", {
              email,
              mono: (chunks) => <span className={mono}>{chunks}</span>,
            })
          : t("login.suspendedBodyNoEmail")}
      </OutcomePanel>
    );
  }

  // A password refused because the organization requires SSO opens the SSO
  // entry too; the key remounts it so it starts open.
  const ssoOpen = ssoRequired || outcome === "ssoRequired";
  const credentialsWrong = outcome === "wrongCredentials";

  return (
    <>
      {header}
      {notice ? (
        <p
          role="status"
          data-testid="login-notice"
          className="rounded-[9px] border border-success/40 bg-success/10 px-3 py-2.5 text-[12.5px] text-foreground"
        >
          {t("login.passwordSet")}
        </p>
      ) : null}
      <AuthPanel>
        {outcome ? (
          <AuthAlert
            testId="login-outcome"
            message={t(`outcomes.${outcome}`)}
          />
        ) : null}
        <OAuthButtons callbackURL={next}>
          <SsoSignIn
            key={ssoOpen ? "open" : "closed"}
            callbackURL={next}
            required={ssoRequired}
            initialOutcome={initialSso}
            startOpen={ssoOpen}
          />
        </OAuthButtons>
        <form
          noValidate
          aria-label={t("login.title")}
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-3.5"
        >
          <Field
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            label={t("fields.email")}
            error={errors.email ? t(`errors.${errors.email}`) : undefined}
            aria-invalid={
              errors.email !== undefined || credentialsWrong ? true : undefined
            }
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
          <label className="flex cursor-pointer items-start gap-[9px] text-[13px] text-foreground">
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
      </AuthPanel>
      {footer}
    </>
  );
}
