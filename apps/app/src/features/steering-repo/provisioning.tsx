"use client";
// A steering repo's provisioning, step by step, as onboarding and the
// repositories page's setup dialog show it (steering-repo-spec, Provisioning).
// Each step reads done, running, failed, blocked, or waiting (./steps). A
// failed or blocked step shows the job's message and, to an owner or admin,
// the way on. An error that asks for Oxagen's grant again shows Re-authorize
// above the steps.
//
// The way on depends on why the step stopped (#4875):
//   choose_connection   pick one of the GitHub organizations or GitLab groups
//                       the setup found, then go on with it
//   no_connection       install the Oxagen app on a GitHub organization, or
//                       authorize it where it is installed, then retry
//   anything else       Retry
//
// A workspace still steered by a code repository (`legacySource`) goes on
// through `import_workspace_steering`, never through a retry of the job: the
// job stops with steering_import_required while that repository holds the
// workspace's steering head. The import answers once the repo exists or
// setup stopped, and its outcome shows under the steps.
import type { SteeringRepoImportOutput } from "@oxagen/oxagen/contracts/steering_repo.import";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { ChoiceGroup } from "@/ui/choice-group";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { useNavigate } from "@/ui/navigation";
import { importWorkspaceSteering, retrySteeringRepoProvision } from "./actions";
import { UNANSWERED, useSteeringRepoFailure } from "./failure";
import { steeringGithubHref } from "./hrefs";
import { ReauthorizeNotice } from "./reauthorize";
import { SteeringRepositoryLink } from "./repository-link";
import { provisioningSteps, type StepState } from "./steps";
import {
  STEERING_CHOOSE_CONNECTION,
  STEERING_NO_CONNECTION,
  STEERING_REAUTHORIZE,
  type SteeringConnectionPick,
  type SteeringRepoView,
} from "./types";

const RETRY_CAPABILITY = "retry_steering_repo_provision";
const IMPORT_CAPABILITY = "import_workspace_steering";

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <CheckIcon aria-hidden className="size-3.5 text-success" />;
    case "running":
      return (
        <CircleNotchIcon
          aria-hidden
          className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
      );
    case "failed":
    case "blocked":
      return <WarningCircleIcon aria-hidden className="size-3.5 text-error-ink" />;
    case "waiting":
      return (
        <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground" />
      );
  }
}

/** The value a choice carries in the picker: `<provider>:<id>`. */
function choiceValue(pick: SteeringConnectionPick): string {
  return `${pick.provider}:${String(pick.id)}`;
}

/**
 * The GitHub organizations and GitLab groups a blocked setup found, and the
 * button that goes on with the one picked.
 */
function ConnectionChooser({
  view,
  pending,
  pendingLabel,
  onPick,
}: {
  view: SteeringRepoView;
  pending: boolean;
  /** What the button says while the pick goes through. */
  pendingLabel: string;
  onPick: (pick: SteeringConnectionPick) => void;
}) {
  const t = useTranslations("repositories.steeringRepo.provisioning");
  const [value, setValue] = useState<string | null>(null);
  const picked =
    view.connectionChoices.find((c) => choiceValue(c) === value) ?? null;
  return (
    <div
      data-testid="steering-repo-choose"
      className="flex w-full flex-col items-start gap-2"
    >
      <p className="text-[12.5px] font-medium text-foreground">
        {t("choose.label")}
      </p>
      <ChoiceGroup
        label={t("choose.label")}
        testId="steering-repo-choice"
        value={value}
        onChange={setValue}
        options={view.connectionChoices.map((c) => ({
          value: choiceValue(c),
          label: c.name,
          sub: t(`choose.provider.${c.provider}`),
        }))}
      />
      <button
        type="button"
        data-testid="steering-repo-use-connection"
        data-touch-target=""
        disabled={pending || picked === null}
        className={buttonSecondary}
        onClick={() => {
          if (picked !== null)
            onPick({ provider: picked.provider, id: picked.id });
        }}
      >
        {pending ? pendingLabel : t("choose.action")}
      </button>
    </div>
  );
}

/** Where an owner connects GitHub when setup found no organization to use. */
function ConnectGithub({
  org,
  returnTo,
}: {
  org: string;
  returnTo: SafePath;
}) {
  const t = useTranslations("repositories.steeringRepo.provisioning.connect");
  return (
    <div
      data-testid="steering-repo-connect"
      className="flex flex-col items-start gap-2"
    >
      <p className="text-[12.5px] text-muted-foreground">{t("body")}</p>
      <div className="flex flex-wrap gap-2">
        <a
          // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub, as ReauthorizeLink does (#4518)
          href={steeringGithubHref(org, { mode: "install" }, returnTo)}
          data-testid="steering-repo-connect-install"
          className={buttonSecondary}
        >
          {t("install")}
        </a>
        <a
          // eslint-disable-next-line no-restricted-syntax -- a same-origin API route that redirects to GitHub, as ReauthorizeLink does (#4518)
          href={steeringGithubHref(org, { mode: "authorize" }, returnTo)}
          data-testid="steering-repo-connect-authorize"
          className={buttonSecondary}
        >
          {t("authorize")}
        </a>
      </div>
    </div>
  );
}

/** What the import did, with the pull requests a person merges. */
function ImportOutcome({ outcome }: { outcome: SteeringRepoImportOutput }) {
  const t = useTranslations("repositories.steeringRepo.provisioning.imported");
  const repository = outcome.steeringRepository ?? "";
  return (
    <div
      role="status"
      data-testid="steering-repo-import-outcome"
      data-outcome={outcome.outcome}
      className="flex flex-col gap-1.5 text-[13px] text-foreground"
    >
      <p>
        {outcome.outcome === "imported"
          ? t("imported", {
              repository,
              count: outcome.pullRequests.length,
            })
          : outcome.outcome === "provisioned"
            ? t("provisioned", { repository })
            : outcome.outcome === "nothing_to_import"
              ? t("nothingToImport", { repository })
              : t("needsChoices", {
                  rules: outcome.rulesNeedingKind.length,
                  constraints: outcome.constraintsNeedingEffect.length,
                })}
      </p>
      {outcome.pullRequests.length === 0 && outcome.cleanup === null ? null : (
        <ol className="ml-4 list-decimal text-[12.5px]">
          {outcome.pullRequests.map((pr) => (
            <li key={pr.number}>
              <a
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {t("pullRequest", { number: pr.number, branch: pr.branch })}
              </a>
            </li>
          ))}
          {outcome.cleanup === null ? null : (
            <li>
              <a
                href={outcome.cleanup.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {t("cleanup", { number: outcome.cleanup.number })}
              </a>
            </li>
          )}
        </ol>
      )}
    </div>
  );
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
  /** Where GitHub sends the person back to after Re-authorize or Connect. */
  returnTo: SafePath;
}) {
  const t = useTranslations("repositories.steeringRepo.provisioning");
  const failureText = useSteeringRepoFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SteeringRepoImportOutput | null>(
    null,
  );
  const steps = provisioningSteps(view, ws);
  const ready = view.status === "ready" ? view.repository : null;
  // A workspace with a legacy source, or one that never started, goes on
  // through the import. The import creates the repo when there is nothing to
  // move.
  const importing =
    ws !== null && (view.legacySource !== null || view.status === "not_started");

  async function goOn(connection?: SteeringConnectionPick) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const capability = importing ? IMPORT_CAPABILITY : RETRY_CAPABILITY;
    try {
      if (importing && ws !== null) {
        const result =
          connection === undefined
            ? await importWorkspaceSteering(org, ws)
            : await importWorkspaceSteering(org, ws, connection);
        if (result.ok) setOutcome(result.value);
        else setFailure(failureText(result, capability));
        // A refused import still records where setup stopped.
        navigate.refresh();
      } else {
        const result =
          connection === undefined
            ? await retrySteeringRepoProvision(org, ws)
            : await retrySteeringRepoProvision(org, ws, connection);
        if (result.ok) navigate.refresh();
        else setFailure(failureText(result, capability));
      }
    } catch {
      setFailure(failureText(UNANSWERED, capability));
    } finally {
      setPending(false);
    }
  }

  const pendingLabel = importing ? t("moving") : t("retrying");
  const code = view.error?.code ?? null;
  const choosing =
    code === STEERING_CHOOSE_CONNECTION && view.connectionChoices.length > 0;

  return (
    <div
      data-testid="steering-repo-provisioning"
      data-status={view.status}
      className="flex flex-col gap-3"
    >
      {code === STEERING_REAUTHORIZE ? (
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
                {!canAct ? null : choosing ? (
                  <ConnectionChooser
                    view={view}
                    pending={pending}
                    pendingLabel={pendingLabel}
                    onPick={(pick) => {
                      void goOn(pick);
                    }}
                  />
                ) : (
                  <>
                    {code === STEERING_NO_CONNECTION ? (
                      <ConnectGithub org={org} returnTo={returnTo} />
                    ) : null}
                    <button
                      type="button"
                      data-testid="steering-repo-retry"
                      data-touch-target=""
                      disabled={pending}
                      className={buttonSecondary}
                      onClick={() => {
                        void goOn();
                      }}
                    >
                      {pending
                        ? pendingLabel
                        : importing
                          ? t("moveSteering")
                          : t("retry")}
                    </button>
                  </>
                )}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {view.status === "not_started" && canAct && ws !== null ? (
        <div className="flex flex-col items-start gap-2">
          <button
            type="button"
            data-testid="steering-repo-start"
            data-touch-target=""
            disabled={pending}
            className={buttonPrimary}
            onClick={() => {
              void goOn();
            }}
          >
            {pending
              ? t("starting")
              : view.legacySource === null
                ? t("create")
                : t("moveSteering")}
          </button>
          <p className="text-[12px] text-muted-foreground">
            {pending ? t("startingNote") : t("startNote")}
          </p>
        </div>
      ) : null}
      {failure === null ? null : (
        <FormAlert testId="steering-repo-retry-failure">{failure}</FormAlert>
      )}
      {outcome === null ? null : <ImportOutcome outcome={outcome} />}
      {ready === null ? null : (
        <p
          data-testid="steering-repo-ready"
          className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-foreground"
        >
          <span>{t("ready")}</span>{" "}
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
