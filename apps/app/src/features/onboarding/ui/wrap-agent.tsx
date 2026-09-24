"use client";
// Step 2 of Register an agent: wrap it. A hook-based harness enrols the machine
// it runs on with a single-use token, which is shown once and consumed the
// first time it is presented. Harnesses without an adapter show an unavailable
// state and cannot advance through an installation this app cannot provide.
//
// Continuing moves the gate's step when this workspace is the gate's, so the
// record follows the operator rather than a timer.
import { useTranslations } from "next-intl";
import { type SyntheticEvent, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary, mono, panel } from "@/ui/control-styles";
import { DesktopDownloads } from "@/ui/desktop-downloads";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { advanceOnboarding, issueEnrollmentToken } from "../actions";
import { type Harness, wrapPathOf } from "../agent-form";
import { UNANSWERED, useOnboardingFailure } from "../failure";
import { useFormatter } from "@/ui/formatter";

type Token = { token: string; expiresAt: string; enrollCommand: string };

function TokenPanel({ token }: { token: Token }) {
  const t = useTranslations("onboarding.register.wrap.token");
  const format = useFormatter();
  return (
    <div data-testid="enrollment-token" className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{t("label")}</p>
      <code
        data-testid="enrollment-token-value"
        className={`${mono} block break-all rounded-md bg-muted px-2 py-1`}
      >
        {token.token}
      </code>
      <p className="text-xs text-muted-foreground">{t("once")}</p>
      <p className="text-xs text-muted-foreground">
        {t("expires", {
          at: format.dateTime(new Date(token.expiresAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
      <p className="text-sm text-muted-foreground">{t("command")}</p>
      <code className={`${mono} block break-all rounded-md bg-muted px-2 py-1`}>
        {token.enrollCommand}
      </code>
    </div>
  );
}

function HostPath({
  org,
  ws,
  agentId,
}: {
  org: string;
  ws: string;
  agentId: string;
}) {
  const t = useTranslations("onboarding.register.wrap.host");
  const failureText = useOnboardingFailure();
  const [token, setToken] = useState<Token | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function mint(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await issueEnrollmentToken(org, ws, agentId);
      if (result.ok) setToken(result.value);
      else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className={`${panel} flex flex-col gap-3 p-4`}>
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">{t("body")}</p>
      {/* Step one on the machine: install the app, which puts the CLIs the
          enroll command runs on PATH. The token and its command come after. */}
      <DesktopDownloads />
      {failure === null ? null : (
        <FormAlert testId="wrap-failure">{failure}</FormAlert>
      )}
      {token === null ? null : <TokenPanel token={token} />}
      <form onSubmit={(e) => void mint(e)} className="flex">
        <SubmitButton
          pending={pending}
          label={token === null ? t("mint") : t("again")}
          pendingLabel={t("pending")}
          fullWidth={false}
        />
      </form>
    </section>
  );
}

function UnavailablePath() {
  const t = useTranslations("onboarding.register.wrap");
  return (
    <section
      data-testid="wrap-unavailable"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <h3 className="text-sm font-semibold">{t("unavailable.title")}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("unavailable.body")}
      </p>
    </section>
  );
}

export function WrapAgent({
  org,
  ws,
  agentId,
  harness,
  gated,
  back,
  next,
}: {
  org: string;
  ws: string;
  agentId: string;
  harness: Harness;
  /** True when this workspace carries the organization's open gate. */
  gated: boolean;
  back: SafePath;
  next: SafePath;
}) {
  const t = useTranslations("onboarding.register.wrap");
  const failureText = useOnboardingFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function advance(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      if (gated) {
        const result = await advanceOnboarding(org, ws, "run");
        if (!result.ok) {
          setFailure(failureText(result));
          return;
        }
      }
      navigate.push(next);
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {wrapPathOf(harness) === "host" ? (
        <HostPath org={org} ws={ws} agentId={agentId} />
      ) : (
        <UnavailablePath />
      )}
      {failure === null ? null : (
        <FormAlert testId="advance-failure">{failure}</FormAlert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SafeLink to={back} className={buttonSecondary}>
          {t("back")}
        </SafeLink>
        {wrapPathOf(harness) === "host" ? (
          <form onSubmit={(e) => void advance(e)}>
            <SubmitButton
              pending={pending}
              label={t("continue")}
              pendingLabel={t("advancing")}
              fullWidth={false}
            />
          </form>
        ) : null}
      </div>
    </div>
  );
}
