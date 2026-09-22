"use client";
// The single sign-on page's smaller writes (ADR-142): copy a value the admin
// pastes elsewhere, check a provider's DNS record, delete a provider after an
// in-page confirm, and require SSO. Each write re-reads the page it changed,
// so what shows next comes from the kernel rather than from this state.
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SsoProvider } from "@/data/contracts/org";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { WriteDialog } from "./dialog";
import {
  deleteSsoProvider,
  setSsoRequired,
  verifySsoDomain,
} from "./sso-actions";
import { SSO_UNANSWERED, type SsoFailure, useSsoFailure } from "./sso-failure";

/**
 * A value with a button that copies it. `navigator.clipboard` is absent over
 * plain HTTP and refused when permission is denied, so the outcome is
 * announced either way and the value stays selectable underneath.
 */
export function CopyValue({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const t = useTranslations("organization.sso.setup");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <button
          type="button"
          className={`${buttonSecondary} h-8 px-2 text-xs`}
          onClick={() => void copy()}
          aria-label={t("copyLabel", { label })}
        >
          {state === "copied" ? t("copied") : t("copy")}
        </button>
      </div>
      <code
        data-testid={testId}
        className={`${mono} block select-all break-all rounded-md border border-border bg-hl px-2.5 py-1.5 text-xs`}
      >
        {value}
      </code>
      <p role="status" className="text-xs text-muted-foreground">
        {state === "failed" ? t("copyFailed") : ""}
      </p>
    </div>
  );
}

/** Looks up the provider's TXT record now, and says what it found. */
export function VerifyDomain({
  org,
  providerId,
}: {
  org: string;
  providerId: string;
}) {
  const t = useTranslations("organization.sso.setup");
  const failureText = useSsoFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SsoFailure | null>(null);
  const [verified, setVerified] = useState(false);

  async function verify() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await verifySsoDomain(org, providerId);
      if (result.ok) {
        setVerified(result.value.domainVerified);
        navigate.refresh();
      } else {
        setFailure(result);
      }
    } catch {
      setFailure(SSO_UNANSWERED);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          className={buttonSecondary}
          onClick={() => void verify()}
          aria-disabled={pending || undefined}
          data-testid={`sso-verify-${providerId}`}
        >
          {pending ? t("verifying") : t("verify")}
        </button>
      </div>
      {failure === null ? null : (
        <FormAlert testId={`sso-verify-${providerId}-failure`}>
          {failureText(failure)}
        </FormAlert>
      )}
      {verified ? (
        <p role="status" className="text-sm">
          {t("verifiedNow")}
        </p>
      ) : null}
    </div>
  );
}

export function DeleteProvider({
  org,
  provider,
}: {
  org: string;
  provider: SsoProvider;
}) {
  const t = useTranslations("organization.sso.delete");
  const navigate = useNavigate();
  return (
    <WriteDialog
      copy={{
        open: t("open"),
        title: t("title", { name: provider.displayName }),
        confirm: t("confirm"),
        pending: t("pending"),
      }}
      testId={`sso-delete-${provider.providerId}`}
      submit={() => deleteSsoProvider(org, provider.providerId)}
      onDone={() => {
        navigate.refresh();
      }}
    >
      <p className="text-sm text-muted-foreground">{t("body")}</p>
    </WriteDialog>
  );
}

/**
 * Require SSO for members other than Owners. Off and unusable until a
 * provider's domain is verified, because nobody could meet the requirement.
 */
export function RequireSso({
  org,
  required,
  canTurnOn,
  canEdit,
}: {
  org: string;
  required: boolean;
  /** At least one provider's domain is verified. */
  canTurnOn: boolean;
  /** Owners and admins change it; the handler checks the role again. */
  canEdit: boolean;
}) {
  const t = useTranslations("organization.sso.policy");
  const failureText = useSsoFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SsoFailure | null>(null);
  // Turning it off stays possible without a verified provider.
  const disabled = !canEdit || pending || (!required && !canTurnOn);

  async function toggle(next: boolean) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await setSsoRequired(org, next);
      if (result.ok) navigate.refresh();
      else setFailure(result);
    } catch {
      setFailure(SSO_UNANSWERED);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <input
          id="sso-required"
          type="checkbox"
          role="switch"
          checked={required}
          onChange={(e) => void toggle(e.target.checked)}
          disabled={disabled}
          aria-describedby="sso-required-state sso-required-owners"
          className="size-4"
          data-testid="sso-required"
        />
        <label htmlFor="sso-required" className="font-medium">
          {t("label")}
        </label>
        {pending ? (
          <span className="text-muted-foreground">{t("saving")}</span>
        ) : null}
      </div>
      <p id="sso-required-state" className="text-sm text-muted-foreground">
        {required ? t("on") : canTurnOn ? t("off") : t("needsVerified")}
      </p>
      <p id="sso-required-owners" className="text-sm text-muted-foreground">
        {t("owners")}
      </p>
      {failure === null ? null : (
        <FormAlert testId="sso-required-failure">
          {failureText(failure)}
        </FormAlert>
      )}
    </div>
  );
}
