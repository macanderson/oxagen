"use client";
// The Repositories page's GitHub setup (MC spec §10.1, §10.2, §11.4): the
// GitHub connection and the steering repository, above the bound repositories
// (bound-repositories.tsx). Installing or connecting the GitHub App and
// attaching an installation happen here.
//
// The steering repository is where `.oxagen/` lives: published steering
// records, the promotion ledger, and every agent definition. Oxagen writes it
// once, through `provision_steering_repo` when the workspace is created
// (ADR-212), so this panel shows it and offers no control that binds one. The
// bind, its re-bind repairs, and the GitLab connect form were removed in
// #4616. #4637 tracks a repair for a retired connection, and #4636 tracks
// GitLab settings.
//
// Every state it can be in is drawn, and none is faked: reading, a refusal of
// that read, a bound and live steering repository, one whose connection was
// retired, and a workspace with no steering repository, with the GitHub doors
// beside it.
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import {
  type SyntheticEvent,
  Suspense,
  useCallback,
  useEffect,
  useState,
} from "react";
import type {
  GitHubInstallations,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import { parseGitLabUrl } from "@/shared/gitlab-url";
import { routes, sanitizeNext } from "@/shared/safe-path";
import { buttonSecondary, eyebrow, linkText, panel } from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink, GitLabLink, useNavigate } from "@/ui/navigation";
import {
  attachGithubInstallation,
  listGithubInstallations,
  readWorkspaceRepository,
} from "./actions";
import {
  UNANSWERED,
  useRepositoriesFailure,
  type RepositoriesFailure,
} from "./failure";
import { useFormatter } from "@/ui/formatter";

/** A record being read, refused, or in hand. The refusal is kept as a value so its sentence is formatted at render. */
type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; failure: RepositoriesFailure }
  | { kind: "ready"; value: T };

const sectionTitle = "text-sm font-semibold text-foreground";
const prose = "text-sm leading-relaxed text-muted-foreground";

/**
 * What the connect leg came back saying; null when it said nothing.
 *
 * Five words, matching GITHUB_ACK in the API's callback, because the person's
 * next click differs in each: an installation was attached; one was claimed and
 * declined; one was claimed and there was nothing to check it against, so the
 * App is installed but not yet attached and one identity round trip finishes
 * it; the account reaches several and has to choose; the account reaches none,
 * so the App has to be installed somewhere before any of this works.
 */
type InstallAcknowledgement =
  | "connected"
  | "failed"
  | "authorize"
  | "choose"
  | "install"
  | null;

/**
 * The query values the API mints, mapped to the words above. Anything else,
 * including a word a newer API grew and this page has not learned, is null:
 * no acknowledgement is the only safe default, since the one thing worse than
 * saying nothing is announcing a connection that did not happen.
 */
const ACKNOWLEDGEMENTS: Record<string, InstallAcknowledgement> = {
  connected: "connected",
  failed: "failed",
  authorize: "authorize",
  choose: "choose",
  install: "install",
};

/**
 * The query the API's OAuth callback sends a person back on:
 * `/{org}/{ws}/repositories?settings=repository&github=connected` after a
 * `returnTo=settings` connect. The acknowledgement is kept and the params are
 * dropped, so a reload does not repeat a sentence about a round trip that is
 * over. Read in its own component because `useSearchParams` needs a Suspense
 * boundary around whatever reads it.
 */
function GitHubReturnQuery({
  onReturned,
}: {
  onReturned: (acknowledgement: InstallAcknowledgement) => void;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const navigate = useNavigate();
  useEffect(() => {
    if (params.get("settings") !== "repository") return;
    const github = params.get("github");
    onReturned((github === null ? null : ACKNOWLEDGEMENTS[github]) ?? null);
    // Back to the path with no query. `replace` also re-renders the server
    // tree, which is wanted here: the workspace just gained an installation,
    // and the pages behind this panel read the same state.
    navigate.replace(sanitizeNext(pathname, routes.root()));
  }, [params, pathname, navigate, onReturned]);
  return null;
}

/**
 * The GitHub connection and the steering repository, as one section of the
 * Repositories tab. `onChanged` tells the page an attach settled, so the
 * repository table above it re-reads.
 */
export function RepositorySetup({
  org,
  ws,
  onChanged,
}: {
  org: string;
  ws: string;
  onChanged?: () => void;
}) {
  const [acknowledgement, setAcknowledgement] =
    useState<InstallAcknowledgement>(null);
  const changed = useCallback(() => {
    onChanged?.();
  }, [onChanged]);
  return (
    <div data-testid="repository-setup">
      <Suspense fallback={null}>
        <GitHubReturnQuery onReturned={setAcknowledgement} />
      </Suspense>
      <MainRepositoryPanel
        org={org}
        ws={ws}
        open
        acknowledgement={acknowledgement}
        onChanged={changed}
      />
    </div>
  );
}

/**
 * Whether the panel draws the GitHub doors, and so reads the installations
 * they offer. A workspace with no steering repository gets them. So does any
 * workspace with no GitHub installation attached, whatever its steering head:
 * Oxagen reads a provisioned head through the Oxagen Steering app, so the head
 * can be live while the workspace has no installation, and linking a code
 * repository still needs one (ADR-212). A bound workspace with an installation
 * attached gets none.
 */
function offersDoors(value: WorkspaceRepository): boolean {
  return value.repository === null || !value.github.connected;
}

function MainRepositoryPanel({
  org,
  ws,
  open,
  acknowledgement,
  onChanged,
}: {
  org: string;
  ws: string;
  open: boolean;
  acknowledgement: InstallAcknowledgement;
  /** An attach settled: the record other sections read moved. */
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const [reloads, setReloads] = useState(0);
  const [settings, setSettings] = useState<Load<WorkspaceRepository>>({
    kind: "loading",
  });
  const [candidates, setCandidates] =
    useState<Load<GitHubInstallations> | null>(null);

  useEffect(() => {
    if (!open) return;
    // The guard is read through a call, and both halves of that matter.
    // A cell, because the cleanup has to be able to write it. A call, because
    // TypeScript narrows `live.current` to true at the first guard and holds
    // that for the rest of the function — so the second guard lints as dead
    // code (`no-unnecessary-condition`) when it is the one that matters most:
    // the await before it is exactly when a person can close the dialog. A
    // call expression carries no narrowing, so the type checker stops claiming
    // to know an answer it cannot have.
    const live = { current: true };
    const cancelled = () => !live.current;
    // The resets open `load`, not the effect body: a setState called
    // synchronously in an effect cascades a render (react-hooks/set-state-in-effect).
    // `void load()` still runs them in this tick, up to the first await, so the
    // panel shows its pending state on the same frame it opens.
    const load = async () => {
      setSettings({ kind: "loading" });
      setCandidates(null);
      let record;
      try {
        record = await readWorkspaceRepository(org, ws);
      } catch {
        record = UNANSWERED;
      }
      if (cancelled()) return;
      if (!record.ok) {
        setSettings({ kind: "failed", failure: record });
        return;
      }
      setSettings({ kind: "ready", value: record.value });
      if (!offersDoors(record.value)) return;

      // The panel asks which installations this account reaches rather than
      // assuming there are none, because that assumption is what made this
      // surface dead-end: the Connect action opens GitHub's identity URL,
      // which always returns a code and never an `installation_id`, so a
      // person whose account already carries the App returns authorized with
      // nothing attached. What they reach is a question only GitHub answers.
      // It is asked with an installation on file too, because
      // `get_main_repository` makes no GitHub call and reports `connected`
      // from the stored id even after the installation was uninstalled on
      // GitHub. Attaching one this account still reaches replaces it.
      setCandidates({ kind: "loading" });
      let reachable;
      try {
        reachable = await listGithubInstallations(org, ws);
      } catch {
        reachable = UNANSWERED;
      }
      if (cancelled()) return;
      setCandidates(
        reachable.ok
          ? { kind: "ready", value: reachable.value }
          : { kind: "failed", failure: reachable },
      );
    };
    void load();
    return () => {
      live.current = false;
    };
  }, [open, org, ws, reloads]);

  const attached = () => {
    setReloads((n) => n + 1);
    onChanged();
  };

  return (
    <section aria-labelledby="workspace-main-repository">
      <h3 id="workspace-main-repository" className={sectionTitle}>
        {t("heading")}
      </h3>
      <p className={`mt-1.5 ${prose}`}>{t("about")}</p>
      {/*
        The acknowledgement describes the return leg from GitHub, so it is worth
        saying exactly once. Any action taken in this panel supersedes it: after
        an attach, "pick which account" would still be on screen beside the
        account already picked, which reads as an instruction the person has
        not followed.
      */}
      <Acknowledgement
        acknowledgement={reloads === 0 ? acknowledgement : null}
      />
      <div className="mt-4">
        {settings.kind === "loading" ? (
          <p
            role="status"
            data-testid="workspace-repository-loading"
            className={prose}
          >
            {t("loading")}
          </p>
        ) : settings.kind === "failed" ? (
          <FormAlert testId="workspace-repository-failure">
            {failureText(settings.failure)}
          </FormAlert>
        ) : settings.value.repository !== null ? (
          <>
            <BoundRepositoryPanel
              repository={settings.value.repository}
              manageUrl={settings.value.github.manageUrl}
            />
            {/*
              No GitHub installation is attached, whether the head is live,
              retired, or on GitLab: the doors are the next click, and they are
              the same doors an unconnected workspace gets. Drawn beside the
              bound panel rather than inside it, so the repository it binds
              stays legible.
            */}
            {offersDoors(settings.value) ? (
              <div className="mt-4">
                <ConnectPanel
                  org={org}
                  ws={ws}
                  connectUrl={settings.value.github.connectUrl}
                  installUrl={settings.value.github.installUrl}
                  candidates={candidates}
                  onAttached={attached}
                />
              </div>
            ) : null}
          </>
        ) : settings.value.github.connected ? (
          <>
            {/*
              An installation is attached and no steering repository is bound.
              Nothing here binds one, because Oxagen writes it when the
              workspace is created. The doors stay, so a stale installation
              can still be replaced.
            */}
            <p data-testid="workspace-repository-provisioned" className={prose}>
              {t("provisioned")}
            </p>
            <div className="mt-4">
              <ConnectPanel
                org={org}
                ws={ws}
                connectUrl={settings.value.github.connectUrl}
                installUrl={settings.value.github.installUrl}
                candidates={candidates}
                onAttached={attached}
                body={t("install.attached")}
              />
            </div>
          </>
        ) : (
          <ConnectPanel
            org={org}
            ws={ws}
            connectUrl={settings.value.github.connectUrl}
            installUrl={settings.value.github.installUrl}
            candidates={candidates}
            onAttached={attached}
          />
        )}
      </div>
    </section>
  );
}

/**
 * The sentence and the test id each acknowledgement carries.
 *
 * A module constant with `as const`, so the keys stay literals: widened to
 * `string` they are not assignable to the message catalog's key type, and it is
 * that type which catches a sentence nobody wrote.
 */
const ACKNOWLEDGEMENT_SENTENCES = {
  connected: { key: "connected", testId: "workspace-github-connected" },
  failed: { key: "installRefused", testId: "workspace-github-failed" },
  authorize: {
    key: "installUnverified",
    testId: "workspace-github-authorize",
  },
  choose: { key: "installChoose", testId: "workspace-github-choose" },
  install: { key: "installNone", testId: "workspace-github-none" },
} as const;

/**
 * What the return leg from GitHub said, when it said anything.
 *
 * Silence is a real answer here and the default one. The panel below draws the
 * doors either way, so without a sentence a person who has just been declined —
 * or who came back to choose between two accounts — would be looking at the
 * controls they just used with nothing explaining why they are back at them.
 */
function Acknowledgement({
  acknowledgement,
}: {
  acknowledgement: InstallAcknowledgement;
}) {
  const t = useTranslations("repositories.mainRepository");
  if (acknowledgement === null) return null;
  const sentence = ACKNOWLEDGEMENT_SENTENCES[acknowledgement];
  return (
    <p
      role="status"
      data-testid={sentence.testId}
      className="mt-3 text-sm text-foreground"
    >
      {t(sentence.key)}
    </p>
  );
}

/**
 * The GitHub doors, and the choice between the installations this account
 * already has.
 *
 * Two doors, because they are two different things and a person arrives
 * needing either. `connectUrl` is GitHub's identity leg — authorize Oxagen as
 * this GitHub user — and it is what makes a SECOND workspace, or a reconnect,
 * possible at all: it returns a code whether or not the App is installed on the
 * account. `installUrl` is `installations/new` — put the App on an account that
 * does not have it — and a first-time user needs precisely that one. This panel
 * used to render only the first, so a person with no installation anywhere
 * authorized, came back unchanged, and pressed the same button again.
 *
 * Between the doors sits the third case: the account already carries the App on
 * more than one org, and nothing but the person can say which one this
 * workspace acts through.
 *
 * `body` is the sentence above the doors, and it is a prop because this panel
 * answers two different questions with the same three controls. Its default
 * says no installation is attached. A workspace with an installation on file
 * gets a different sentence, because telling that person nothing is attached
 * would be a sentence the panel knows to be false.
 */
function ConnectPanel({
  org,
  ws,
  connectUrl,
  installUrl,
  candidates,
  onAttached,
  body,
}: {
  org: string;
  ws: string;
  connectUrl: string | null;
  installUrl: string | null;
  candidates: Load<GitHubInstallations> | null;
  onAttached: () => void;
  /** The sentence above the doors; the "nothing is attached yet" one by default. */
  body?: string;
}) {
  const t = useTranslations("repositories.mainRepository");
  const connectHref = parseGitHubUrl(connectUrl);
  const installHref = parseGitHubUrl(installUrl);
  return (
    <div data-testid="workspace-repository-install" className={`${panel} p-4`}>
      <h4 className={sectionTitle}>{t("install.heading")}</h4>
      <p className={`mt-1.5 ${prose}`}>{body ?? t("install.body")}</p>
      <InstallationPicker
        org={org}
        ws={ws}
        candidates={candidates}
        onAttached={onAttached}
      />
      {connectHref === null && installHref === null ? (
        <p
          data-testid="workspace-github-unconfigured"
          className={`mt-3 ${prose}`}
        >
          {t("unconfigured")}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {installHref === null ? null : (
            <GitHubLink
              to={installHref}
              data-testid="workspace-github-install"
              data-touch-target=""
              className={buttonSecondary}
            >
              {t("install.action")}
            </GitHubLink>
          )}
          {connectHref === null ? null : (
            <GitHubLink
              to={connectHref}
              data-testid="workspace-github-connect"
              data-touch-target=""
              className={buttonSecondary}
            >
              {t("install.connect")}
            </GitHubLink>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The installations this workspace's GitHub authorization already reaches, and
 * the one submit that settles which of them it acts through.
 *
 * Drawn only when there is something to draw. A workspace that has never
 * authorized GitHub refuses this read with `github_not_authorized`, which is
 * not a fault — it is the ordinary first-time state, and the doors below
 * already say what to do about it — so it is drawn as nothing rather than as an
 * alarm. Every other refusal is shown, because a list that could not be read
 * and a list with nothing in it are different facts and only one of them means
 * "install the App".
 */
function InstallationPicker({
  org,
  ws,
  candidates,
  onAttached,
}: {
  org: string;
  ws: string;
  candidates: Load<GitHubInstallations> | null;
  onAttached: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const navigate = useNavigate();
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (candidates === null) return null;
  if (candidates.kind === "loading") {
    return (
      <p
        role="status"
        data-testid="workspace-installations-loading"
        className={`mt-3 ${prose}`}
      >
        {t("installations.loading")}
      </p>
    );
  }
  if (candidates.kind === "failed") {
    // The precondition, not a fault: nobody has authorized GitHub for this org
    // yet. The Connect door below is the answer, and an alert here would put a
    // red box on the most ordinary state this panel has.
    if (
      "code" in candidates.failure &&
      candidates.failure.code === "github_not_authorized"
    ) {
      return null;
    }
    return (
      <div className="mt-3">
        <FormAlert testId="workspace-installations-failure">
          {failureText(candidates.failure)}
        </FormAlert>
      </div>
    );
  }

  const { installations } = candidates.value;
  if (installations.length === 0) return null;

  async function attach(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const chosen = installations.find(
      (installation) => installation.installationId === picked,
    );
    if (chosen === undefined) {
      setFailure(t("installations.none"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await attachGithubInstallation(
        org,
        ws,
        chosen.installationId,
      );
      if (result.ok) {
        // The panel re-reads, now with this installation attached, and the
        // server tree re-renders, because the pages behind this panel read the
        // same state.
        onAttached();
        navigate.refresh();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      noValidate
      data-testid="workspace-installation-picker"
      className="mt-4"
      onSubmit={(e) => void attach(e)}
    >
      <h5 className={sectionTitle}>{t("installations.heading")}</h5>
      <p className={`mt-1 ${prose}`}>{t("installations.about")}</p>
      <fieldset className="mt-3 flex flex-col gap-1">
        <legend className="sr-only">{t("installations.listLabel")}</legend>
        {installations.map((installation) => (
          <label
            key={installation.installationId}
            data-touch-target=""
            className="flex min-h-11 items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
          >
            <input
              type="radio"
              name="installation"
              value={installation.installationId}
              checked={picked === installation.installationId}
              onChange={() => {
                setPicked(installation.installationId);
              }}
            />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-[13px] font-semibold">
                {installation.accountLogin}
              </b>
              <span className="block truncate text-xs text-muted-foreground">
                {installation.repositorySelection === "all"
                  ? t("installations.allRepositories")
                  : t("installations.selectedRepositories")}
              </span>
            </span>
            {installation.accountType === null ? null : (
              <span className="flex-none rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {installation.accountType}
              </span>
            )}
          </label>
        ))}
      </fieldset>
      {failure === null ? null : (
        <div className="mt-3">
          <FormAlert testId="workspace-installation-attach-failure">
            {failure}
          </FormAlert>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <SubmitButton
          pending={pending}
          fullWidth={false}
          label={t("installations.attach")}
          pendingLabel={t("installations.attaching")}
        />
      </div>
    </form>
  );
}

/**
 * The steering repository is bound: what it is, where `.oxagen/` is read from,
 * and, when the connection behind it was retired, that steering is off.
 *
 * Those are the same panel on purpose. A person meeting the second state
 * deleted a GitHub connection and reconnected, which is an ordinary thing to
 * do. What they need told is that the repository is still the one on screen
 * and that nothing else about the workspace moved. Drawing it as a separate
 * "broken" surface would read as though the binding itself were lost. The
 * panel offers no repair: the bind that did one was removed in #4616, and
 * #4637 tracks its successor.
 */
function BoundRepositoryPanel({
  repository,
  manageUrl,
}: {
  repository: NonNullable<WorkspaceRepository["repository"]>;
  manageUrl: string | null;
}) {
  const t = useTranslations("repositories.mainRepository");
  const onGitLab = repository.provider === "gitlab";
  const href = onGitLab ? null : parseGitHubUrl(repository.htmlUrl);
  const gitlabHref = onGitLab ? parseGitLabUrl(repository.htmlUrl) : null;
  return (
    <div data-testid="workspace-repository-bound" className={`${panel} p-4`}>
      <p className={eyebrow}>{t("bound.heading")}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-foreground">
        {repository.fullName}
      </p>
      <p className={`mt-1 ${prose}`}>
        {t("bound.defaultRef")}: <code>{repository.defaultRef}</code>
      </p>
      <p className={`mt-1 ${prose}`}>
        <BoundAt iso={repository.boundAt} />
      </p>
      {href === null ? null : (
        <GitHubLink
          to={href}
          data-testid="workspace-repository-open"
          className={`mt-2 inline-block ${linkText}`}
        >
          {t("bound.open")}
        </GitHubLink>
      )}
      {gitlabHref === null ? null : (
        <GitLabLink
          to={gitlabHref}
          data-testid="workspace-repository-open"
          className={`mt-2 inline-block ${linkText}`}
        >
          {t("bound.openGitLab")}
        </GitLabLink>
      )}
      {repository.connectionLive ? (
        onGitLab ? null : (
          <ManageLink manageUrl={manageUrl} />
        )
      ) : (
        <div className="mt-3" data-testid="workspace-repository-retired">
          <FormAlert>{t("bound.retired")}</FormAlert>
        </div>
      )}
    </div>
  );
}

/** When the binding was written, as a date a person reads; the machine value stays in `dateTime`. */
function BoundAt({ iso }: { iso: string }) {
  const t = useTranslations("repositories.mainRepository");
  const format = useFormatter();
  return (
    <time dateTime={iso} data-testid="workspace-repository-bound-at">
      {t("bound.boundAt", {
        date: format.dateTime(new Date(iso), { dateStyle: "medium" }),
      })}
    </time>
  );
}

function ManageLink({ manageUrl }: { manageUrl: string | null }) {
  const t = useTranslations("repositories.mainRepository");
  const href = parseGitHubUrl(manageUrl);
  if (href === null) return null;
  return (
    <GitHubLink
      to={href}
      data-testid="workspace-github-manage"
      className={`mt-3 inline-block ${linkText}`}
    >
      {t("manage")}
    </GitHubLink>
  );
}
