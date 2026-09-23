"use client";
// Enterprise single sign-on entry on /login (ADR-145). A button opens a small
// form that asks for the work email; Better Auth finds the organization's
// identity provider by the email's domain and sends the browser there, and the
// provider returns it to `callbackURL`, the same destination the password form
// uses. It is its own <form> because forms cannot nest, so LoginForm renders it
// beside the password form.
//
// `required` is set when requireViewer sent the person here because their
// organization requires SSO and the session was not an SSO one: the entry
// starts open under a notice saying why.
import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, panel } from "@/ui/control-styles";
import { Field } from "@/ui/field";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import type { AuthOutcomeKey } from "../auth-errors";
import { liveSignInSso } from "../auth-client";
import { formText } from "../form-text";
import { type FieldErrors, fieldErrors, SsoSignInSchema } from "../schemas";

export type SsoSignInProps = {
  callbackURL: SafePath;
  /** The organization requires SSO: open the entry and say why. */
  required?: boolean;
  /** An SSO failure the page already knows about (an identity-provider `?error=`). */
  initialOutcome?: AuthOutcomeKey | null;
  /** Start with the form open (the password form was refused with SSO_REQUIRED). */
  startOpen?: boolean;
};

export function SsoSignIn({
  callbackURL,
  required = false,
  initialOutcome = null,
  startOpen = false,
}: SsoSignInProps) {
  const t = useTranslations("auth");
  const tSso = useTranslations("auth.sso");
  const formId = useId();
  const [open, setOpen] = useState(
    startOpen || required || initialOutcome !== null,
  );
  const [errors, setErrors] = useState<FieldErrors<"email">>({});
  const [outcome, setOutcome] = useState<AuthOutcomeKey | null>(initialOutcome);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const parsed = SsoSignInSchema.safeParse({
      email: formText(form, "email"),
    });
    setOutcome(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const result = await liveSignInSso({
        email: parsed.data.email,
        callbackURL,
      });
      if (!result.ok) {
        setOutcome(result.outcome);
        setPending(false);
      }
      // On success Better Auth's client is already navigating to the identity
      // provider, so the button stays pending until the page unloads.
    } catch {
      setOutcome("unavailable");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {required ? (
        <div
          role="status"
          data-testid="sso-required"
          className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm text-foreground"
        >
          <KeyRound
            aria-hidden
            className="mt-0.5 size-4 flex-none text-muted-foreground"
          />
          <span>{tSso("required")}</span>
        </div>
      ) : null}
      {open ? (
        <form
          id={formId}
          noValidate
          aria-label={tSso("formLabel")}
          onSubmit={(e) => void onSubmit(e)}
          className={`${panel} flex flex-col gap-4 p-5 sm:p-6`}
        >
          <p className="text-sm text-muted-foreground">{tSso("lead")}</p>
          {outcome ? (
            <FormAlert testId="sso-outcome">
              {t(`outcomes.${outcome}`)}
            </FormAlert>
          ) : null}
          <Field
            id={`${formId}-email`}
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            label={t("fields.email")}
            error={errors.email ? t(`errors.${errors.email}`) : undefined}
          />
          <SubmitButton
            secondary
            pending={pending}
            label={tSso("submit")}
            pendingLabel={tSso("pending")}
          />
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
          }}
          className={`${buttonSecondary} justify-start`}
        >
          <KeyRound aria-hidden className="size-4 flex-none" />
          <span>{tSso("entry")}</span>
        </button>
      )}
    </div>
  );
}
