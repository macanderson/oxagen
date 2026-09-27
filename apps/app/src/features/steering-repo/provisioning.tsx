"use client";
// A steering repo's provisioning, step by step, as onboarding and the
// repositories card show it (steering-repo-spec, Provisioning). Each step reads
// done, running, failed, blocked, or waiting (./steps). A failed or blocked
// step shows the job's message and, to an owner or admin, Retry. An error that
// asks for Oxagen Steering's grant again shows Re-authorize above the steps.
import { Check, CircleAlert, CircleDashed, LoaderCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { retrySteeringRepoProvision } from "./actions";
import { UNANSWERED, useSteeringRepoFailure } from "./failure";
import { ReauthorizeNotice } from "./reauthorize";
import { SteeringRepositoryLink } from "./repository-link";
import { provisioningSteps, type StepState } from "./steps";
import { STEERING_REAUTHORIZE, type SteeringRepoView } from "./types";

const RETRY_CAPABILITY = "retry_steering_repo_provision";

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <Check aria-hidden className="size-3.5 text-success" />;
    case "running":
      return (
        <LoaderCircle
          aria-hidden
          className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      );
    case "failed":
    case "blocked":
      return <CircleAlert aria-hidden className="size-3.5 text-error-ink" />;
    case "waiting":
      return (
        <CircleDashed aria-hidden className="size-3.5 text-muted-foreground" />
      );
  }
}

export function SteeringRepoProvisioning({
  org,
  ws,
  view,
  canAct,
  returnTo,
}: {
  org: string;
  /** The workspace the repo is for, or null before the organization has one. */
  ws: string | null;
  view: SteeringRepoView;
  /** An owner or admin: Retry is theirs. */
  canAct: boolean;
  /** Where GitHub sends the person back to after Re-authorize. */
  returnTo: SafePath;
}) {
  const t = useTranslations("repositories.steeringRepo.provisioning");
  const failureText = useSteeringRepoFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const steps = provisioningSteps(view, ws);
  const ready = view.status === "ready" ? view.repository : null;

  async function retry() {
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      const result = await retrySteeringRepoProvision(org, ws);
      if (result.ok) navigate.refresh();
      else setFailure(failureText(result, RETRY_CAPABILITY));
    } catch {
      setFailure(failureText(UNANSWERED, RETRY_CAPABILITY));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-testid="steering-repo-provisioning"
      data-status={view.status}
      className="flex flex-col gap-3"
    >
      {view.error?.code === STEERING_REAUTHORIZE ? (
        <ReauthorizeNotice
          org={org}
          provider={view.provider}
          returnTo={returnTo}
          canAct={canAct}
        />
      ) : null}
      <ol aria-label={t("stepsLabel")} className="flex flex-col gap-2">
        {steps.map(({ step, state }) => (
          <li
            key={step}
            data-step={step}
            data-state={state}
            aria-current={state === "running" ? "step" : undefined}
            className="flex flex-col gap-1.5 text-[13px]"
          >
            <span className="flex items-center gap-2">
              <StepIcon state={state} />
              <span
                className={
                  state === "waiting"
                    ? "text-muted-foreground"
                    : "text-foreground"
                }
              >
                {t(`steps.${step}`)}
              </span>
              <span className="text-[12px] text-muted-foreground">
                {t(`state.${state}`)}
              </span>
            </span>
            {(state === "failed" || state === "blocked") &&
            view.error !== null ? (
              <div className="ml-[22px] flex flex-col items-start gap-2">
                <p
                  data-testid="steering-repo-step-error"
                  className="text-[12.5px] text-muted-foreground"
                >
                  {view.error.message}
                </p>
                {canAct ? (
                  <button
                    type="button"
                    data-testid="steering-repo-retry"
                    data-touch-target=""
                    disabled={pending}
                    className={buttonSecondary}
                    onClick={() => {
                      void retry();
                    }}
                  >
                    {pending ? t("retrying") : t("retry")}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {failure === null ? null : (
        <FormAlert testId="steering-repo-retry-failure">{failure}</FormAlert>
      )}
      {ready === null ? null : (
        <p
          data-testid="steering-repo-ready"
          className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-foreground"
        >
          <span>{t("ready")}</span>
          <SteeringRepositoryLink
            provider={view.provider}
            repository={ready}
            testId="steering-repo-ready-link"
          />
        </p>
      )}
    </div>
  );
}
