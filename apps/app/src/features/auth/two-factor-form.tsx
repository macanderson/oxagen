"use client";
// The sign-in second factor (mockup `obTwoFactor`). Reached holding only Better
// Auth's short-lived two-factor cookie, so the route is public. Six digit boxes
// take the authenticator code; a single-use recovery code completes sign-in
// instead. The header lives here because its lead names the address the
// password step was for, which only this browser tab knows.

import { useTranslations } from "next-intl";
import { type SyntheticEvent, useEffect, useState } from "react";
import type { AuthOutcomeKey } from "./auth-errors";
import {
  liveVerifyTwoFactor,
  takePendingEmail,
  takePendingNext,
} from "./auth-client";
import { routes, type SafePath, sanitizeNext } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { type AuthErrorKey, TwoFactorSchema, fieldErrors } from "./schemas";
import { Field } from "@/ui/field";
import { SubmitButton } from "@/ui/form-feedback";
import { mono } from "@/ui/control-styles";
import { PageHeader } from "@/ui/page-header";
import { formText } from "./form-text";
import { AuthAlert, AuthPanel, authLinkButton } from "./ui/auth-card";
import { CodeInput } from "./ui/code-input";

type Method = "totp" | "backup";

/** Better Auth's TOTP period (the plugin's default): a code is valid for the rest of its 30-second window. */
const TOTP_PERIOD_SECONDS = 30;

function secondsLeft(now: number): number {
  return TOTP_PERIOD_SECONDS - (Math.floor(now / 1000) % TOTP_PERIOD_SECONDS);
}

/** "expires 0:24": how long the code on the authenticator app stays valid. Rendered after hydration only. */
function ExpiryClock() {
  const t = useTranslations("auth.twoFactor");
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => {
      setLeft(secondsLeft(Date.now()));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  if (left === null) return null;
  return (
    <span
      data-testid="two-factor-expiry"
      className="font-mono text-[11.5px] text-dim"
    >
      {t("expires", { time: `0:${String(left).padStart(2, "0")}` })}
    </span>
  );
}

export function TwoFactorForm({
  next,
  eyebrow,
  title,
}: {
  next: SafePath;
  /** The page's eyebrow and its `pages.twoFactor` title, for the header this form renders. */
  eyebrow: string;
  title: string;
}) {
  const t = useTranslations("auth");
  const navigate = useNavigate();
  const [method, setMethod] = useState<Method>("totp");
  const [error, setError] = useState<AuthErrorKey | null>(null);
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  // A refused code clears the boxes by remounting them.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setEmail(takePendingEmail());
  }, []);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = TwoFactorSchema.safeParse({
      method,
      code: formText(form, "code"),
    });
    setOutcome(null);
    if (!parsed.success) {
      setError(fieldErrors(parsed.error).code ?? "codeInvalid");
      return;
    }
    setError(null);
    setPending(true);
    try {
      // A live sign-in that stopped here may have lost ?next= to Better Auth's own redirect.
      const destination =
        next !== routes.root()
          ? next
          : sanitizeNext(takePendingNext(), routes.root());
      const result = await liveVerifyTwoFactor(parsed.data);
      if (!result.ok) {
        setOutcome(result.outcome);
        setAttempt((n) => n + 1);
        return;
      }
      navigate.replace(destination);
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  const lead =
    method === "backup"
      ? t("twoFactor.leadBackup")
      : email
        ? t.rich("twoFactor.lead", {
            email,
            mono: (chunks) => <span className={mono}>{chunks}</span>,
          })
        : t("twoFactor.leadNoEmail");

  return (
    <>
      <PageHeader eyebrow={eyebrow} title={title} description={lead} />
      <AuthPanel>
        {outcome ? (
          <AuthAlert
            testId="two-factor-outcome"
            message={t(`outcomes.${outcome}`)}
          />
        ) : null}
        <form
          noValidate
          aria-label={t("twoFactor.title")}
          onSubmit={(e) => void onSubmit(e)}
          className="flex flex-col gap-3.5"
        >
          {method === "totp" ? (
            <CodeInput
              key={`totp-${attempt}`}
              id="two-factor-code"
              name="code"
              label={t("fields.code")}
              digitLabel={(n) => t("fields.digit", { n })}
              error={error ? t(`errors.${error}`) : undefined}
            />
          ) : (
            <Field
              key={`backup-${attempt}`}
              id="two-factor-backup"
              name="code"
              type="text"
              autoComplete="one-time-code"
              maxLength={32}
              className="font-mono"
              label={t("fields.backupCode")}
              error={error ? t(`errors.${error}`) : undefined}
            />
          )}
          <SubmitButton
            pending={pending}
            label={t("twoFactor.submit")}
            pendingLabel={t("twoFactor.pending")}
          />
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <button
              type="button"
              className={authLinkButton}
              onClick={() => {
                setError(null);
                setOutcome(null);
                setMethod((m) => (m === "totp" ? "backup" : "totp"));
              }}
            >
              {method === "totp"
                ? t("twoFactor.useBackup")
                : t("twoFactor.useTotp")}
            </button>
            {method === "totp" ? <ExpiryClock /> : null}
          </div>
        </form>
      </AuthPanel>
    </>
  );
}
