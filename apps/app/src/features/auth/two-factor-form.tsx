"use client";
// The sign-in second factor (mockup `obTwoFactor` @ mc-baseline-w1). Reached
// holding only Better Auth's short-lived two-factor cookie, so the route is
// public. An authenticator code or a single-use recovery code completes sign-in.

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import { verifyTwoFactorFixture } from "./actions";
import type { AuthOutcomeKey } from "./auth-errors";
import { liveVerifyTwoFactor, takePendingNext } from "./client-auth";
import { DEFAULT_NEXT, sanitizeNext } from "./safe-next";
import { TwoFactorSchema, fieldErrors } from "./schemas";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { linkText, panel } from "@/ui/control-styles";
import { formText } from "./form-text";

type Method = "totp" | "backup";

export function TwoFactorForm({
  next,
  fixture,
}: {
  next: string;
  fixture: boolean;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [method, setMethod] = useState<Method>("totp");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(null);
  const [pending, setPending] = useState(false);

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
        next !== DEFAULT_NEXT ? next : sanitizeNext(takePendingNext());
      const result = fixture
        ? await verifyTwoFactorFixture({ ...parsed.data, next: destination })
        : await liveVerifyTwoFactor(parsed.data);
      if (!result.ok) {
        setOutcome(result.outcome ?? "codeWrong");
        return;
      }
      router.replace("to" in result ? result.to : destination);
      router.refresh();
    } catch {
      setOutcome("unavailable");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.95rem] leading-relaxed text-muted-foreground">
        {method === "totp" ? t("twoFactor.lead") : t("twoFactor.leadBackup")}
      </p>
      <form
        noValidate
        aria-label={t("twoFactor.title")}
        onSubmit={(e) => void onSubmit(e)}
        className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
      >
        {outcome ? (
          <FormAlert testId="two-factor-outcome">
            {t(`outcomes.${outcome}`)}
          </FormAlert>
        ) : null}
        <Field
          key={method}
          id="two-factor-code"
          name="code"
          type="text"
          autoComplete="one-time-code"
          inputMode={method === "totp" ? "numeric" : "text"}
          maxLength={method === "totp" ? 6 : 32}
          className={
            method === "totp"
              ? "font-mono text-lg tracking-[0.4em]"
              : "font-mono"
          }
          label={method === "totp" ? t("fields.code") : t("fields.backupCode")}
          error={error ? t(`errors.${error}`) : undefined}
        />
        <SubmitButton
          pending={pending}
          label={t("twoFactor.submit")}
          pendingLabel={t("twoFactor.pending")}
        />
        <button
          type="button"
          className={`${linkText} self-start text-sm`}
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
      </form>
    </div>
  );
}
