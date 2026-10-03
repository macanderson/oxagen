"use client";
// A steering repo's provisioning, step by step, as onboarding and the
// repositories page's setup dialog show it (steering-repo-spec, Provisioning).
// Each step reads done, running, failed, blocked, or waiting (./steps). A
// failed or blocked step shows the job's message and, to an owner or admin,
// the way on. An error that asks for Oxagen's grant again shows Re-authorize
// above the steps.
//
// The way on depends on why the step stopped (#4875):
//   choose_connection          pick one of the GitHub organizations or GitLab
//                              groups the setup found, then go on with it
//   no_connection              install the Oxagen app on a GitHub organization,
//                              or authorize it where it is installed, then retry
//   repository_name_taken      enter another repository name, then retry
//   unknown_connection,        pick another organization or group, and another
//   repository_create_refused  name if needed, then retry
//   anything else              Retry
//
// The last three apply to a workspace whose setup has not created its
// repository yet (#5196). The name field starts on the name the setup tried,
// and the retry sends only what the person changed.
//
// The connection belongs to the whole organization. Picking it, changing it,
// connecting GitHub and authorizing Oxagen again are an org Owner's or
// Admin's (`canChangeConnection`). The workspace's Owner and Admin retry,
// rename, create, move and repair their own setup (`canAct`, #5228).
//
// The Host connection step names where steering repos go. Until Oxagen has
// created a repo there, an owner can switch to a different organization, which
// clears the stored one so setup asks again (#4899).
//
// A workspace still steered by a code repository (`legacySource`) goes on
// through `import_workspace_steering`, never through a retry of the job: the
// job stops with steering_import_required while that repository holds the
// workspace's steering head. The import answers once the repo exists or
// setup stopped, and its outcome shows under the steps. The import reads
// only a GitHub repository, so a GitLab source gets a note and no action. A
// workspace on a retired sources connection, which the import refuses, gets
// the empty steering repo only after a person confirms it (`startFresh`).
//
// An import that stopped after its demote step goes on through the import
// too (`pendingMove`, #5082). The old repository no longer steers by then,
// so `legacySource` reads null, and a retry of the job would finish the repo
// and leave the `.oxagen/` tree where it was. Once the repo is ready, Finish
// the move resumes the run, which opens the steering PRs and the cleanup PR.
import type { SteeringRepoImportOutput } from "@oxagen/oxagen/contracts/steering_repo.import";
import {
  CheckIcon,
  CircleDashedIcon,
  CircleNotchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { parseGitHubUrl } from "@/shared/github-url";
import { parseGitLabUrl } from "@/shared/gitlab-url";
import type { SafePath } from "@/shared/safe-path";
import { ChoiceGroup } from "@/ui/choice-group";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { FormAlert } from "@/ui/form-feedback";
import { GitHubLink, GitLabLink, useNavigate } from "@/ui/navigation";
import {
  importWorkspaceSteering,
  readSteeringRepoDestinations,
  retrySteeringRepoProvision,
} from "./actions";
import {
  defaultRepoNameForSlug,
  repoNameAccepted,
  steeringRepoDraftOf,
} from "./destination";
import { SteeringRepoDestinationFields } from "./destination-fields";
import { UNANSWERED, useSteeringRepoFailure } from "./failure";
import { steeringGithubHref } from "./hrefs";
import { ReauthorizeNotice } from "./reauthorize";
import { SteeringRepositoryLink } from "./repository-link";
import { provisioningSteps, type StepState } from "./steps";
import {
  STEERING_CHOOSE_CONNECTION,
  STEERING_IMPORT_LEGACY_CONNECTION,
  STEERING_NO_CONNECTION,
  STEERING_REAUTHORIZE,
  STEERING_REPOSITORY_CREATE_REFUSED,
  STEERING_REPOSITORY_NAME_TAKEN,
  STEERING_UNKNOWN_CONNECTION,
  pendingMove,
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
      <p className="text-sm font-medium text-foreground">
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
          sub: t(
            `choose.provider.${c.provider === "github" && c.kind === "user" ? "githubUser" : c.provider}`,
          ),
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

/** What a retry changes about a workspace's steering repo before it exists. */
type RepoChanges = { name?: string; connection?: SteeringConnectionPick };

/**
 * A setup that stopped on the name or the place the workspace chose, before
 * Oxagen created anything (#5196): the Repository name, starting on the name
 * the setup tried, and, when the place is the problem, the Organization
 * select. Retry sends the name only when the person changed it.
 */
function RetryWithChanges({
  org,
  ws,
  view,
  withPlaces,
  pending,
  pendingLabel,
  onRetry,
}: {
  org: string;
  ws: string;
  view: SteeringRepoView;
  /** Draw the Organization select too. */
  withPlaces: boolean;
  pending: boolean;
  pendingLabel: string;
  onRetry: (changes: RepoChanges) => void;
}) {
  const t = useTranslations("repositories.steeringRepo.provisioning");
  const tried = view.requestedName ?? defaultRepoNameForSlug(ws);
  return (
    <form
      noValidate
      data-testid="steering-repo-change"
      aria-label={t("retry")}
      className="flex w-full flex-col items-start gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (pending || !repoNameAccepted(event.currentTarget)) return;
        const draft = steeringRepoDraftOf(new FormData(event.currentTarget));
        const name =
          draft?.name !== undefined && draft.name !== tried
            ? draft.name
            : undefined;
        onRetry({
          ...(name === undefined ? {} : { name }),
          ...(draft?.connection === undefined
            ? {}
            : { connection: draft.connection }),
        });
      }}
    >
      <SteeringRepoDestinationFields
        org={org}
        load={readSteeringRepoDestinations}
        defaultName={tried}
        idPrefix="steering-repo-change"
        places={withPlaces}
      />
      <button
        type="submit"
        data-testid="steering-repo-retry"
        data-touch-target=""
        disabled={pending}
        className={buttonSecondary}
      >
        {pending ? pendingLabel : t("retry")}
      </button>
    </form>
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
      <p className="text-sm text-muted-foreground">{t("body")}</p>
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

const prLinkClass = "underline underline-offset-2";

/** A pull request on GitHub or GitLab, or its label alone at any other address. */
function PullRequestLink({ url, children }: { url: string; children: ReactNode }) {
  const github = parseGitHubUrl(url);
  if (github !== null)
    return (
      <GitHubLink to={github} className={prLinkClass}>
        {children}
      </GitHubLink>
    );
  const gitlab = parseGitLabUrl(url);
  if (gitlab !== null)
    return (
      <GitLabLink to={gitlab} className={prLinkClass}>
        {children}
      </GitLabLink>
    );
  return <span>{children}</span>;
}

/** Why a workspace steered by a GitLab repository has no setup action here. */
function GitlabSourceNote({ view }: { view: SteeringRepoView }) {
  const t = useTranslations("repositories.steeringRepo.provisioning");
  return (
    <p
      data-testid="steering-repo-gitlab-source"
      className="text-sm text-muted-foreground"
    >
      {t("gitlabSource", { legacy: view.legacySource?.fullName ?? "" })}
    </p>
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
      className="flex flex-col gap-1.5 text-sm text-foreground"
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
        <ol className="ml-4 list-decimal text-sm">
          {outcome.pullRequests.map((pr) => (
            <li key={pr.number}>
              <PullRequestLink url={pr.url}>
                {t("pullRequest", { number: pr.number, branch: pr.branch })}
              </PullRequestLink>
            </li>
          ))}
          {outcome.cleanup === null ? null : (
            <li>
              <PullRequestLink url={outcome.cleanup.url}>
                {t("cleanup", { number: outcome.cleanup.number })}
              </PullRequestLink>
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
  canChangeConnection = canAct,
  returnTo,
}: {
  org: string;
  /** The workspace the repo is for, or null before the organization has one. */
  ws: string | null;
  view: SteeringRepoView;
  /** An org or workspace Owner or Admin: Retry is theirs. */
  canAct: boolean;
  /**
   * An org Owner or Admin: picking, changing, connecting and authorizing the
   * organization's connection is theirs. The same as `canAct` when omitted.
   */
  canChangeConnection?: boolean;
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
  // The import refused a retired sources connection, so the way on is an
  // empty steering repo, which a person confirms.
  const [fresh, setFresh] = useState(false);
  const steps = provisioningSteps(view, ws);
  const ready = view.status === "ready" ? view.repository : null;
  const moving = pendingMove(view);
  // A workspace with a legacy source, one that never started, or one whose
  // import stopped partway goes on through the import. The import creates the
  // repo when there is nothing to move.
  const importing =
    ws !== null &&
    (view.legacySource !== null ||
      view.status === "not_started" ||
      moving !== null);
  // The import reads `.oxagen/` only from GitHub.
  const movable =
    view.legacySource === null || view.legacySource.provider === "github";

  async function goOn(
    options: {
      connection?: SteeringConnectionPick;
      startFresh?: true;
      resetConnection?: true;
      name?: string;
    } = {},
  ) {
    if (pending) return;
    setPending(true);
    setFailure(null);
    const { connection, resetConnection, name } = options;
    const capability = importing ? IMPORT_CAPABILITY : RETRY_CAPABILITY;
    const bare = Object.keys(options).length === 0;
    try {
      if (importing) {
        const result = bare
          ? await importWorkspaceSteering(org, ws)
          : await importWorkspaceSteering(org, ws, options);
        if (result.ok) {
          setOutcome(result.value);
          setFresh(false);
        } else {
          setFailure(failureText(result, capability));
          setFresh(
            "code" in result &&
              result.code === STEERING_IMPORT_LEGACY_CONNECTION,
          );
        }
        // A refused import still records where setup stopped.
        navigate.refresh();
      } else {
        const result =
          connection === undefined &&
          resetConnection === undefined &&
          name === undefined
            ? await retrySteeringRepoProvision(org, ws)
            : await retrySteeringRepoProvision(org, ws, {
                ...(connection === undefined ? {} : { connection }),
                ...(resetConnection === undefined ? {} : { resetConnection }),
                ...(name === undefined ? {} : { name }),
              });
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
  // A workspace setup that stopped on its name or its place before Oxagen
  // created anything takes a new name, and a new place where the place is the
  // problem (#5196).
  const placeStopped =
    code === STEERING_UNKNOWN_CONNECTION ||
    code === STEERING_REPOSITORY_CREATE_REFUSED;
  const renaming =
    ws !== null &&
    !importing &&
    view.repository === null &&
    (code === STEERING_REPOSITORY_NAME_TAKEN || placeStopped);
  // An owner may switch organizations until Oxagen has created a repo in the
  // stored one (Mac, 2026-10-01). A repo whose setup stopped before its first
  // version, such as on a plan that cannot protect its branches, does not
  // count (#4900).
  const changeable =
    canChangeConnection &&
    movable &&
    view.connection !== null &&
    view.publishedVersion === null &&
    (view.status === "failed" || view.status === "blocked");
  const place =
    view.connection === null
      ? null
      : view.connection.provider === "gitlab"
        ? "group"
        : view.connection.kind;

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
          canAct={canChangeConnection}
        />
      ) : null}
      <ol aria-label={t("stepsLabel")} className="flex flex-col gap-2">
        {steps.map(({ step, state }) => (
          <li
            key={step}
            data-step={step}
            data-state={state}
            aria-current={state === "running" ? "step" : undefined}
            className="flex flex-col gap-1.5 text-sm"
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
              <span className="text-sm text-muted-foreground">
                {t(`state.${state}`)}
              </span>
            </span>
            {step === "pick_connection" && view.connection !== null ? (
              <div className="ml-5.5 flex flex-wrap items-center gap-2">
                <p
                  data-testid="steering-repo-connection"
                  data-kind={place ?? undefined}
                  className="text-sm text-muted-foreground"
                >
                  {t(`connection.${place ?? "organization"}`, {
                    name: view.connection.name,
                  })}
                </p>
                {changeable ? (
                  <button
                    type="button"
                    data-testid="steering-repo-change-connection"
                    data-touch-target=""
                    disabled={pending}
                    className={buttonSecondary}
                    onClick={() => {
                      void goOn({ resetConnection: true });
                    }}
                  >
                    {t(
                      place === "group"
                        ? "connection.changeGroup"
                        : "connection.change",
                    )}
                  </button>
                ) : null}
              </div>
            ) : null}
            {(state === "failed" || state === "blocked") &&
            view.error !== null ? (
              <div className="ml-5.5 flex flex-col items-start gap-2">
                <p
                  data-testid="steering-repo-step-error"
                  className="text-sm text-muted-foreground"
                >
                  {view.error.message}
                </p>
                {!canAct ? null : !movable ? (
                  <GitlabSourceNote view={view} />
                ) : choosing && !canChangeConnection ? null : choosing ? (
                  <ConnectionChooser
                    view={view}
                    pending={pending}
                    pendingLabel={pendingLabel}
                    onPick={(pick) => {
                      void goOn({ connection: pick });
                    }}
                  />
                ) : renaming ? (
                  <RetryWithChanges
                    org={org}
                    ws={ws}
                    view={view}
                    withPlaces={placeStopped && canChangeConnection}
                    pending={pending}
                    pendingLabel={pendingLabel}
                    onRetry={(changes) => {
                      void goOn(changes);
                    }}
                  />
                ) : (
                  <>
                    {code === STEERING_NO_CONNECTION && canChangeConnection ? (
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
      {view.status === "not_started" && canAct && ws !== null && !movable ? (
        <GitlabSourceNote view={view} />
      ) : null}
      {view.status === "not_started" && canAct && ws !== null && movable ? (
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
          <p className="text-sm text-muted-foreground">
            {pending ? t("startingNote") : t("startNote")}
          </p>
        </div>
      ) : null}
      {failure === null ? null : (
        <FormAlert testId="steering-repo-retry-failure">{failure}</FormAlert>
      )}
      {fresh && canAct ? (
        <div
          data-testid="steering-repo-fresh"
          className="flex flex-col items-start gap-2"
        >
          <p className="text-sm text-muted-foreground">
            {t("fresh.body")}
          </p>
          <button
            type="button"
            data-testid="steering-repo-start-fresh"
            data-touch-target=""
            disabled={pending}
            className={buttonSecondary}
            onClick={() => {
              void goOn({ startFresh: true });
            }}
          >
            {pending ? t("starting") : t("fresh.action")}
          </button>
        </div>
      ) : null}
      {view.status === "ready" &&
      moving !== null &&
      canAct &&
      ws !== null &&
      outcome === null ? (
        <div
          data-testid="steering-repo-finish-move"
          className="flex flex-col items-start gap-2"
        >
          <p className="text-sm text-muted-foreground">
            {t("finishMove.body", { legacy: moving.fullName })}
          </p>
          <button
            type="button"
            data-testid="steering-repo-finish-move-action"
            data-touch-target=""
            disabled={pending}
            className={buttonPrimary}
            onClick={() => {
              void goOn();
            }}
          >
            {pending ? t("moving") : t("finishMove.action")}
          </button>
        </div>
      ) : null}
      {outcome === null ? null : <ImportOutcome outcome={outcome} />}
      {ready === null ? null : (
        <p
          data-testid="steering-repo-ready"
          className="flex flex-wrap items-baseline gap-x-1.5 text-sm text-foreground"
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
