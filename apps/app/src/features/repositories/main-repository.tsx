"use client";
// The Repositories page's GitHub setup (MC spec §10.1, §10.2, §11.4): the main
// repository panel and, below it, the bound repositories (bound-repositories.tsx)
// that it links and unlinks. Both used to live in a Workspace settings dialog
// opened from the workspace menu. The menu no longer carries Settings, and
// nothing the dialog did was dropped: installing or connecting the GitHub App,
// attaching an installation, binding the main repository, reconnecting a retired
// binding, re-approving its branch, and linking or unlinking a second
// repository all happen here, on the page the mockup draws for them.
//
// Why the main repository matters: it is where `.oxagen/` lives (published
// steering records, the promotion ledger, and every agent definition), and
// until a workspace binds one it stays provisional. This panel opens the App's
// install door and then lists what the installation actually reaches, so the
// set on screen is the set `bind_main_repository` accepts.
//
// Every state it can be in is drawn, and none is faked: reading, no
// installation, an unconfigured deployment, a picker over a live GitHub list,
// a bound repository, and each refusal the three capabilities can give.
import { useTranslations } from "next-intl";
import { usePathname, useSearchParams } from "next/navigation";
import {
  type SyntheticEvent,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import type {
  GitHubInstallations,
  InstallationRepositories,
  WorkspaceRepository,
} from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import { parseGitLabUrl } from "@/shared/gitlab-url";
import { routes, sanitizeNext } from "@/shared/safe-path";
import {
  buttonSecondary,
  eyebrow,
  inputBase,
  linkText,
  panel,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink, GitLabLink, useNavigate } from "@/ui/navigation";
import {
  attachGithubInstallation,
  bindWorkspaceRepository,
  connectGitLabProject,
  listGithubInstallations,
  listInstallationRepositories,
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
    // and the provisional banner is stale.
    navigate.replace(sanitizeNext(pathname, routes.root()));
  }, [params, pathname, navigate, onReturned]);
  return null;
}

/**
 * The GitHub connection and the main repository, as one section of the
 * Repositories tab. `onChanged` tells the page a bind, re-bind or attach
 * settled, so the repository table above it re-reads.
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
  /** A bind, re-bind or attach settled: the record other sections read moved. */
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const [reloads, setReloads] = useState(0);
  const [settings, setSettings] = useState<Load<WorkspaceRepository>>({
    kind: "loading",
  });
  const [listing, setListing] = useState<Load<InstallationRepositories> | null>(
    null,
  );
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
      setListing(null);
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
      // A bound workspace whose connection is still live needs neither list:
      // the panel shows what it binds. One whose connection was retired is a
      // different state — steering is off and the repair binds the same
      // repository again through a LIVE connection — so it falls through to
      // the doors below when there is no live connection to repair through.
      const repository = record.value.repository;
      if (repository !== null && repository.connectionLive) return;

      if (record.value.github.connected) {
        // A bound repository is repaired by re-binding the one it already
        // names, so the picker's list is not what this state asks for.
        if (repository !== null) return;
        // An installation is attached and nothing is bound: the repositories it
        // reaches are the set the bind accepts.
        setListing({ kind: "loading" });
        let repositories;
        try {
          repositories = await listInstallationRepositories(org, ws);
        } catch {
          repositories = UNANSWERED;
        }
        if (cancelled()) return;
        if (repositories.ok) {
          setListing({ kind: "ready", value: repositories.value });
          return;
        }
        setListing({ kind: "failed", failure: repositories });
        // A listing that refused with an installation on file is the one state
        // `get_main_repository` cannot see: it makes no GitHub call, so it
        // reports `connected` from the stored installation id whether or not
        // that installation still exists. An installation uninstalled or
        // suspended on GitHub fails here, at the token, and nowhere earlier.
        // So this falls through to the candidates read rather than returning:
        // the fastest way out is attaching an installation this account still
        // reaches, which overwrites the id on file, and only GitHub can say
        // which those are.
      }

      // No installation attached, or the one attached could not be used. The
      // panel asks rather than assuming there is nothing to pick from, because
      // that assumption is what made this surface dead-end: the Connect action
      // opens GitHub's identity URL, which always returns a code and never an
      // `installation_id`, so a person whose account already carries the App
      // returns authorized with nothing attached. What they reach is a
      // question only GitHub answers.
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

  const bound = () => {
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
        an attach, "pick which account" is still on screen while the repository
        picker it asked for is already drawn, which reads as an instruction the
        person has not followed.
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
              org={org}
              ws={ws}
              repository={settings.value.repository}
              connected={settings.value.github.connected}
              manageUrl={settings.value.github.manageUrl}
              onRepaired={bound}
            />
            {/*
              A retired connection with no live one to repair through: the
              doors are the next click, and they are the same doors an
              unconnected workspace gets. Drawn beside the bound panel rather
              than inside it, so the repository it still binds stays legible.
            */}
            {settings.value.repository.connectionLive ||
            settings.value.repository.provider === "gitlab" ||
            settings.value.github.connected ? null : (
              <div className="mt-4">
                <ConnectPanel
                  org={org}
                  ws={ws}
                  connectUrl={settings.value.github.connectUrl}
                  installUrl={settings.value.github.installUrl}
                  candidates={candidates}
                  onAttached={bound}
                />
              </div>
            )}
          </>
        ) : settings.value.github.connected ? (
          <>
            <RepositoryPicker
              org={org}
              ws={ws}
              listing={listing}
              manageUrl={settings.value.github.manageUrl}
              onBound={bound}
            />
            {/*
              The listing refused with an installation on file, which is what a
              revoked, uninstalled or suspended installation looks like from
              here — `get_main_repository` makes no GitHub call, so it goes on
              reporting `connected` from the stored id. Without this the panel
              was the error and nothing else: no way to replace the stale
              installation and no way to reinstall the App, on the one surface
              that owns both. Same doors an unconnected workspace gets, because
              they are the same next click, and drawn beside the refusal rather
              than instead of it so the reason stays on screen.
            */}
            {listing !== null && listing.kind === "failed" ? (
              <div className="mt-4">
                <ConnectPanel
                  org={org}
                  ws={ws}
                  connectUrl={settings.value.github.connectUrl}
                  installUrl={settings.value.github.installUrl}
                  candidates={candidates}
                  onAttached={bound}
                  body={t("install.unreachable")}
                />
              </div>
            ) : null}
          </>
        ) : (
          <ConnectPanel
            org={org}
            ws={ws}
            connectUrl={settings.value.github.connectUrl}
            installUrl={settings.value.github.installUrl}
            candidates={candidates}
            onAttached={bound}
          />
        )}
        {/*
          The other host (#3762). Offered whenever nothing is bound, beside the
          GitHub doors rather than behind them: a workspace that keeps its code
          on gitlab.com never needs the GitHub App.
        */}
        {settings.kind === "ready" && settings.value.repository === null ? (
          <div className="mt-4">
            <GitLabPanel org={org} ws={ws} onBound={bound} />
          </div>
        ) : null}
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
 * No installation is attached yet. Both doors, and the choice between the
 * installations this account already has.
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
 * says no installation is attached. The repository picker draws it with a
 * different sentence when the listing refused: an installation IS on file
 * there, it simply could not be used, and telling that person nothing is
 * attached would be a sentence the panel knows to be false.
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
        // The panel re-reads — it is now connected, so the next thing it draws
        // is the repository picker — and the server tree re-renders, because
        // the onboarding gate's provisional banner behind this dialog reads the
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
 * A repository is bound: what it is, where `.oxagen/` is read from, and either
 * why this is not the place to change it or — when the connection behind it was
 * retired — that steering is off and how to get it back.
 *
 * Those are the same panel on purpose. A person meeting the second state
 * deleted a GitHub connection and reconnected, which is an ordinary thing to
 * do; what they need told is that the repository is still the one on screen and
 * that nothing else about the workspace moved. Drawing it as a separate
 * "broken" surface would read as though the binding itself were lost.
 */
function BoundRepositoryPanel({
  org,
  ws,
  repository,
  connected,
  manageUrl,
  onRepaired,
}: {
  org: string;
  ws: string;
  repository: NonNullable<WorkspaceRepository["repository"]>;
  /** A live GitHub connection is attached, so the repair has something to bind through. */
  connected: boolean;
  manageUrl: string | null;
  onRepaired: () => void;
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
          {t("gitlab.open")}
        </GitLabLink>
      )}
      {repository.connectionLive ? (
        <>
          {/*
            Spec §10.1: moving a workspace to a DIFFERENT repository is an org
            owner's decision recorded as a security event, and
            `bind_main_repository` refuses it with `main_repo_bound`. A control
            offering THAT here would be a control that lies, which is why none
            is offered and the copy says so.

            Re-approving the default branch below is not that control. It binds
            the same owner and name — nothing about which repository is main
            moves — and it is the only way the approved production ref ever
            changes, because steering reads the ref from the binding and never
            from live GitHub.
          */}
          <p className={`mt-3 ${prose}`}>{t("bound.fixed")}</p>
          <ReapproveDefaultRef
            org={org}
            ws={ws}
            repository={repository}
            onRepaired={onRepaired}
          />
          {onGitLab ? null : <ManageLink manageUrl={manageUrl} />}
        </>
      ) : onGitLab ? (
        // The token was revoked or the connection deleted. The repair is a
        // new token for the same project; which project is main never moves.
        <div className="mt-3" data-testid="workspace-repository-retired">
          <FormAlert>{t("bound.retired")}</FormAlert>
          <div className="mt-3">
            <GitLabPanel
              org={org}
              ws={ws}
              projectPath={repository.fullName}
              onBound={onRepaired}
            />
          </div>
        </div>
      ) : (
        <RetiredConnection
          org={org}
          ws={ws}
          repository={repository}
          connected={connected}
          onRepaired={onRepaired}
        />
      )}
    </div>
  );
}

/**
 * The connection this binding hangs off is gone, so steering is off (#3233).
 *
 * Reached by deleting the workspace's GitHub connection and reconnecting:
 * the delete leaves the old row mid-delete, the reconnect attaches a new
 * connection, and the binding head goes on naming the retired one — so every
 * reader that joins the two resolves nothing and no Context PR can be opened,
 * while the repository still reads as bound. Until `get_main_repository`
 * reported `connectionLive`, nothing on any surface said so, and re-binding the
 * same repository took the bind's idempotent branch and moved nothing.
 *
 * The repair is that same bind, on the same owner and name. It supersedes the
 * binding onto the live connection, which is why this is not the "change the
 * main repository" control the panel refuses to offer above: nothing about
 * which repository is main changes here.
 */
function RetiredConnection({
  org,
  ws,
  repository,
  connected,
  onRepaired,
}: {
  org: string;
  ws: string;
  repository: NonNullable<WorkspaceRepository["repository"]>;
  connected: boolean;
  onRepaired: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function reconnect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      // The SAME repository, by the owner and name the binding already
      // carries: a repair, never a choice of a different repo.
      const result = await bindWorkspaceRepository(org, ws, {
        owner: repository.owner,
        name: repository.name,
      });
      if (result.ok) {
        onRepaired();
        navigate.refresh();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3" data-testid="workspace-repository-retired">
      <FormAlert>{t("bound.retired")}</FormAlert>
      {/*
        No live connection to bind through: the bind would refuse with
        `github_not_connected`, so the doors below this panel are the next
        click and an action here would only be a button that fails.
      */}
      {!connected ? null : (
        <form noValidate className="mt-3" onSubmit={(e) => void reconnect(e)}>
          {failure === null ? null : (
            <div className="mb-3">
              <FormAlert testId="workspace-repository-reconnect-failure">
                {failure}
              </FormAlert>
            </div>
          )}
          <SubmitButton
            pending={pending}
            fullWidth={false}
            secondary
            label={t("bound.reconnect")}
            pendingLabel={t("bound.reconnecting")}
          />
        </form>
      )}
    </div>
  );
}

/**
 * The approved production ref, re-read from GitHub on demand (#3265 review, P1).
 *
 * Steering resolves `defaultBranch` from the binding's `configuredDefaultRef`,
 * and `assertProductionBase` refuses any Context PR whose base is not it. That
 * is deliberate — it is what stops a default-branch rename on GitHub silently
 * retargeting every Context PR at a branch nobody approved. The cost is that a
 * rename leaves the workspace pinned to a branch that may no longer exist, and
 * until this control the pin had no way to move: `bind_main_repository` treated
 * a same-repository re-bind as idempotent, and `set_main_repository` is a spec
 * entry with no contract and no handler. Steering stopped and nothing on any
 * surface could restart it.
 *
 * Offered unconditionally rather than only when drift is detected, because
 * detecting it would put a GitHub round trip on every settings render:
 * `get_main_repository` is a pure binding read today. The bind compares the
 * recorded facts against what GitHub reports and writes a successor only if
 * they differ, so pressing this when nothing has moved is a no-op that returns
 * the existing binding's identity.
 */
function ReapproveDefaultRef({
  org,
  ws,
  repository,
  onRepaired,
}: {
  org: string;
  ws: string;
  repository: NonNullable<WorkspaceRepository["repository"]>;
  onRepaired: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function reapprove(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    try {
      // The SAME owner and name the binding already carries. A re-approval of
      // this repository's current default branch, never a choice of another
      // repository — the bind refuses that with `main_repo_bound` regardless.
      const result = await bindWorkspaceRepository(
        org,
        ws,
        repository.provider === "gitlab"
          ? { provider: "gitlab", projectPath: repository.fullName }
          : { owner: repository.owner, name: repository.name },
      );
      if (result.ok) {
        onRepaired();
        navigate.refresh();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-3" data-testid="workspace-repository-reapprove">
      <p className={prose}>{t("bound.refDrift")}</p>
      <form noValidate className="mt-3" onSubmit={(e) => void reapprove(e)}>
        {failure === null ? null : (
          <div className="mb-3">
            <FormAlert testId="workspace-repository-reapprove-failure">
              {failure}
            </FormAlert>
          </div>
        )}
        <SubmitButton
          pending={pending}
          fullWidth={false}
          secondary
          label={t("bound.reapprove")}
          pendingLabel={t("bound.reapproving")}
        />
      </form>
    </div>
  );
}

/**
 * Connect a gitlab.com project with a project access token and bind it as the
 * main repository (#3762). The same form repairs a GitLab binding whose token
 * was revoked: the path is fixed to the bound project and a new token rotates
 * the stored one.
 *
 * The token field is a password field with autocomplete off, and the value is
 * cleared once the write settles either way, so the token does not sit in the
 * page after it has been sent.
 */
function GitLabPanel({
  org,
  ws,
  projectPath: fixedPath,
  onBound,
}: {
  org: string;
  ws: string;
  /** The bound project, for a repair; the path is then not editable. */
  projectPath?: string;
  onBound: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const navigate = useNavigate();
  const pathId = useId();
  const tokenId = useId();
  const [path, setPath] = useState(fixedPath ?? "");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function connect(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const result = await connectGitLabProject(org, ws, {
        projectPath: path.trim(),
        token: token.trim(),
      });
      if (result.ok) {
        if (result.value.webhook === "refused")
          setNotice(t("gitlab.webhookRefused"));
        onBound();
        navigate.refresh();
      } else setFailure(failureText(result));
    } catch {
      setFailure(failureText(UNANSWERED));
    } finally {
      setToken("");
      setPending(false);
    }
  }

  return (
    <div data-testid="workspace-gitlab-connect" className={`${panel} p-4`}>
      <h4 className={sectionTitle}>
        {fixedPath === undefined
          ? t("gitlab.heading")
          : t("gitlab.reconnectHeading")}
      </h4>
      <p className={`mt-1.5 ${prose}`}>
        {fixedPath === undefined
          ? t("gitlab.body")
          : t("gitlab.reconnectBody", { project: fixedPath })}
      </p>
      <form noValidate className="mt-3" onSubmit={(e) => void connect(e)}>
        {failure === null ? null : (
          <div className="mb-3">
            <FormAlert testId="workspace-gitlab-failure">{failure}</FormAlert>
          </div>
        )}
        {notice === null ? null : (
          <p
            role="status"
            data-testid="workspace-gitlab-notice"
            className={`mb-3 ${prose}`}
          >
            {notice}
          </p>
        )}
        <label htmlFor={pathId} className="text-sm font-medium text-foreground">
          {t("gitlab.pathLabel")}
        </label>
        <input
          id={pathId}
          data-testid="workspace-gitlab-path"
          className={`mt-1 ${inputBase}`}
          value={path}
          readOnly={fixedPath !== undefined}
          placeholder={t("gitlab.pathHint")}
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(e) => {
            setPath(e.target.value);
          }}
        />
        <label
          htmlFor={tokenId}
          className="mt-3 block text-sm font-medium text-foreground"
        >
          {t("gitlab.tokenLabel")}
        </label>
        <input
          id={tokenId}
          data-testid="workspace-gitlab-token"
          className={`mt-1 ${inputBase}`}
          type="password"
          value={token}
          autoComplete="off"
          spellCheck={false}
          required
          onChange={(e) => {
            setToken(e.target.value);
          }}
        />
        <p className={`mt-1.5 text-xs ${prose}`}>{t("gitlab.selfManaged")}</p>
        <div className="mt-3">
          <SubmitButton
            pending={pending}
            fullWidth={false}
            secondary
            label={t("gitlab.submit")}
            pendingLabel={t("gitlab.submitting")}
          />
        </div>
      </form>
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

/** The set `bind_main_repository` accepts, filtered by name, with one submit. */
function RepositoryPicker({
  org,
  ws,
  listing,
  manageUrl,
  onBound,
}: {
  org: string;
  ws: string;
  listing: Load<InstallationRepositories> | null;
  manageUrl: string | null;
  onBound: () => void;
}) {
  const t = useTranslations("repositories.mainRepository");
  const failureText = useRepositoriesFailure();
  const navigate = useNavigate();
  const filterId = useId();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  if (listing === null || listing.kind === "loading") {
    return (
      <p
        role="status"
        data-testid="workspace-repositories-loading"
        className={prose}
      >
        {t("picker.loading")}
      </p>
    );
  }
  if (listing.kind === "failed") {
    // The refusal, and the one control the ready path offers that still means
    // something here. A listing can refuse because the installation is gone —
    // the doors drawn beside this panel are the answer to that — or because it
    // is suspended or reaches nothing this token may read, and that is settled
    // on the App's own page, which is where this link goes. Returning the
    // alert alone is what stranded the workspace (#3233): the state was
    // reachable and had no affordance to leave it.
    return (
      <div data-testid="workspace-repositories-refused">
        <FormAlert testId="workspace-repositories-failure">
          {failureText(listing.failure)}
        </FormAlert>
        <ManageLink manageUrl={manageUrl} />
      </div>
    );
  }

  const { repositories, truncated } = listing.value;
  const needle = query.trim().toLocaleLowerCase();
  const shown =
    needle === ""
      ? repositories
      : repositories.filter((repository) =>
          repository.fullName.toLocaleLowerCase().includes(needle),
        );

  async function bind(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    // Resolved from `shown`, not `repositories`: a selection the filter has
    // since hidden is not a choice this form is offering. Searching the
    // unfiltered list would bind a repository that is not on screen — and
    // because a bound main repo cannot be changed from here (spec §10.1 makes
    // that an org-owner decision), a stray keystroke in the filter box would
    // bind the wrong repository permanently. `picked` is deliberately left
    // alone so the selection survives clearing the filter again.
    const chosen = shown.find((repository) => repository.id === picked);
    if (chosen === undefined) {
      setFailure(t("picker.none"));
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const result = await bindWorkspaceRepository(org, ws, {
        owner: chosen.owner,
        name: chosen.name,
      });
      if (result.ok) {
        // The panel re-reads, and the rest of the app re-renders: the bind
        // closes the onboarding gate's provisional window, which the Fleet
        // banner behind this dialog is drawing from.
        onBound();
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
      data-testid="workspace-repository-picker"
      onSubmit={(e) => void bind(e)}
    >
      <h4 className={sectionTitle}>{t("picker.heading")}</h4>
      {repositories.length === 0 ? (
        <p
          data-testid="workspace-repositories-empty"
          className={`mt-2 ${prose}`}
        >
          {t("picker.empty")}
        </p>
      ) : (
        <>
          <label htmlFor={filterId} className={`mt-3 block ${eyebrow}`}>
            {t("picker.filterLabel")}
          </label>
          <input
            id={filterId}
            type="search"
            data-testid="workspace-repository-filter"
            className={`mt-1 ${inputBase}`}
            placeholder={t("picker.filterPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {shown.length === 0 ? (
            <p
              data-testid="workspace-repositories-no-match"
              className={`mt-3 ${prose}`}
            >
              {t("picker.noMatch", { query: query.trim() })}
            </p>
          ) : (
            <fieldset className="mt-3 flex flex-col gap-1">
              <legend className="sr-only">{t("picker.listLabel")}</legend>
              {shown.map((repository) => (
                <label
                  key={repository.id}
                  data-touch-target=""
                  className="flex min-h-11 items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring"
                >
                  <input
                    type="radio"
                    name="repository"
                    value={repository.id}
                    checked={picked === repository.id}
                    onChange={() => {
                      setPicked(repository.id);
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <b className="block truncate font-mono text-[13px] font-semibold">
                      {repository.fullName}
                    </b>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t("picker.defaultBranch", {
                        ref: repository.defaultBranch,
                      })}
                    </span>
                  </span>
                  {repository.private ? (
                    <span className="flex-none rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {t("picker.private")}
                    </span>
                  ) : null}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      {truncated ? (
        <p
          data-testid="workspace-repositories-truncated"
          className={`mt-3 ${prose}`}
        >
          {t("picker.truncated")}
        </p>
      ) : null}
      <ManageLink manageUrl={manageUrl} />
      {failure === null ? null : (
        <div className="mt-3">
          <FormAlert testId="workspace-repository-bind-failure">
            {failure}
          </FormAlert>
        </div>
      )}
      {repositories.length === 0 ? null : (
        <div className="mt-4 flex justify-end">
          <SubmitButton
            pending={pending}
            fullWidth={false}
            label={t("picker.bind")}
            pendingLabel={t("picker.binding")}
          />
        </div>
      )}
    </form>
  );
}
