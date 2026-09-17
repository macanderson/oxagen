"use client";
// The Workspace settings dialog, whose one panel is Main repository (MC spec
// §10.1–§10.2, #2967).
//
// Why it exists: the main repo is where `.oxagen/` lives — published steering
// records, the promotion ledger, and every agent definition — and until a
// workspace binds one it stays provisional. Before this, the only place to
// bind was the onboarding gate's provisional banner, which offers exactly one
// repository (the git remote the enrolling host happened to report) and
// refuses with `github_not_connected` unless an installation is already
// attached, which nothing in the app could produce. This panel opens the App's
// install door and then lists what the installation actually reaches, so the
// set on screen is the set `bind_main_repository` accepts.
//
// It is a `SheetDialog` like every other dialog here, so on a phone it rises
// from the bottom edge with a drag handle, a scrim and a full-width footer
// button (ARCHITECTURE.md §1.2; src/ui/phone.css keys on its data attributes).
//
// Every state it can be in is drawn, and none is faked: reading, no
// installation, an unconfigured deployment, a picker over a live GitHub list,
// a bound repository, and each refusal the three capabilities can give.
import { useFormatter, useTranslations } from "next-intl";
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
import { routes, sanitizeNext } from "@/shared/safe-path";
import {
  buttonSecondary,
  eyebrow,
  inputBase,
  linkText,
  panel,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { GitHubLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { useSidebarSections } from "./sidebar";
import {
  attachGithubInstallation,
  bindWorkspaceRepository,
  listGithubInstallations,
  listInstallationRepositories,
  readWorkspaceRepository,
} from "./workspace-settings-actions";
import {
  UNANSWERED,
  useWorkspaceSettingsFailure,
  type WorkspaceSettingsFailure,
} from "./workspace-settings-failure";

/** A record being read, refused, or in hand. The refusal is kept as a value so its sentence is formatted at render. */
type Load<T> =
  | { kind: "loading" }
  | { kind: "failed"; failure: WorkspaceSettingsFailure }
  | { kind: "ready"; value: T };

const sectionTitle = "text-sm font-semibold text-foreground";
const prose = "text-sm leading-relaxed text-muted-foreground";

/**
 * What the connect leg came back saying; null when it said nothing.
 *
 * Four words, matching GITHUB_ACK in the API's callback, because the person's
 * next click differs in each: an installation was attached; one was claimed and
 * declined; the account reaches several and has to choose; the account reaches
 * none, so the App has to be installed somewhere before any of this works.
 */
type InstallAcknowledgement =
  | "connected"
  | "failed"
  | "choose"
  | "install"
  | null;

/**
 * The query values the API mints, mapped to the words above. Anything else —
 * including a word a newer API grew and this dialog has not learned — is null:
 * no acknowledgement is the only safe default, since the one thing worse than
 * saying nothing is announcing a connection that did not happen.
 */
const ACKNOWLEDGEMENTS: Record<string, InstallAcknowledgement> = {
  connected: "connected",
  failed: "failed",
  choose: "choose",
  install: "install",
};

/**
 * The query the API's OAuth callback sends a person back on:
 * `?settings=repository&github=connected` after a `returnTo=settings` connect.
 * The dialog opens on it and the params are dropped, so a reload does not
 * re-open a panel the person has closed. Read in its own component because
 * `useSearchParams` needs a Suspense boundary around whatever reads it.
 */
function SettingsQuery({
  onRequested,
}: {
  onRequested: (acknowledgement: InstallAcknowledgement) => void;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const navigate = useNavigate();
  useEffect(() => {
    if (params.get("settings") !== "repository") return;
    const github = params.get("github");
    onRequested((github === null ? null : ACKNOWLEDGEMENTS[github]) ?? null);
    // Back to the path with no settings query. `replace` also re-renders the
    // server tree, which is wanted here: the workspace just gained an
    // installation, and the provisional banner behind the dialog is stale.
    navigate.replace(sanitizeNext(pathname, routes.root()));
  }, [params, pathname, navigate, onRequested]);
  return null;
}

export function WorkspaceSettingsDialog({ data }: { data: ShellData }) {
  const t = useTranslations("workspaceSettings");
  const { workspaceSettingsOpen, setWorkspaceSettingsOpen } = useShellState();
  const { ws } = useSidebarSections(data);
  const [acknowledgement, setAcknowledgement] =
    useState<InstallAcknowledgement>(null);

  const onRequested = useCallback(
    (outcome: InstallAcknowledgement) => {
      setAcknowledgement(outcome);
      setWorkspaceSettingsOpen(true);
    },
    [setWorkspaceSettingsOpen],
  );

  // Without a workspace in the URL there is no workspace to settle: the
  // sidebar hides the control in that case, and the return leg always lands on
  // a workspace path.
  if (ws === null) return null;
  return (
    <>
      <Suspense fallback={null}>
        <SettingsQuery onRequested={onRequested} />
      </Suspense>
      <SheetDialog
        open={workspaceSettingsOpen}
        onOpenChange={setWorkspaceSettingsOpen}
        title={t("title")}
        testId="workspace-settings-dialog"
      >
        <MainRepositoryPanel
          org={data.org.slug}
          ws={ws}
          open={workspaceSettingsOpen}
          acknowledgement={acknowledgement}
        />
      </SheetDialog>
    </>
  );
}

function MainRepositoryPanel({
  org,
  ws,
  open,
  acknowledgement,
}: {
  org: string;
  ws: string;
  open: boolean;
  acknowledgement: InstallAcknowledgement;
}) {
  const t = useTranslations("workspaceSettings.mainRepository");
  const failureText = useWorkspaceSettingsFailure();
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
      // A bound workspace needs neither list: the panel shows what it binds.
      if (record.value.repository !== null) return;

      if (record.value.github.connected) {
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
        setListing(
          repositories.ok
            ? { kind: "ready", value: repositories.value }
            : { kind: "failed", failure: repositories },
        );
        return;
      }

      // No installation attached. The panel asks rather than assuming there is
      // nothing to pick from, because that assumption is what made this
      // surface dead-end: the Connect action opens GitHub's identity URL,
      // which always returns a code and never an `installation_id`, so a
      // person whose account already carries the App returns authorized with
      // nothing attached. What they reach is a question only GitHub answers.
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
  };

  return (
    <section aria-labelledby="workspace-main-repository">
      <h3 id="workspace-main-repository" className={sectionTitle}>
        {t("heading")}
      </h3>
      <p className={`mt-1.5 ${prose}`}>{t("about")}</p>
      <Acknowledgement acknowledgement={acknowledgement} />
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
          <BoundRepositoryPanel
            repository={settings.value.repository}
            manageUrl={settings.value.github.manageUrl}
          />
        ) : settings.value.github.connected ? (
          <RepositoryPicker
            org={org}
            ws={ws}
            listing={listing}
            manageUrl={settings.value.github.manageUrl}
            onBound={bound}
          />
        ) : (
          <ConnectPanel
            org={org}
            ws={ws}
            connectUrl={settings.value.github.installUrl}
            installUrl={settings.value.github.manageUrl}
            candidates={candidates}
            onAttached={bound}
          />
        )}
      </div>
    </section>
  );
}

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
  const t = useTranslations("workspaceSettings.mainRepository");
  if (acknowledgement === null) return null;
  const sentence = {
    connected: { key: "connected", testId: "workspace-github-connected" },
    failed: { key: "installRefused", testId: "workspace-github-failed" },
    choose: { key: "installChoose", testId: "workspace-github-choose" },
    install: { key: "installNone", testId: "workspace-github-none" },
  }[acknowledgement];
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
 */
function ConnectPanel({
  org,
  ws,
  connectUrl,
  installUrl,
  candidates,
  onAttached,
}: {
  org: string;
  ws: string;
  connectUrl: string | null;
  installUrl: string | null;
  candidates: Load<GitHubInstallations> | null;
  onAttached: () => void;
}) {
  const t = useTranslations("workspaceSettings.mainRepository");
  const connectHref = parseGitHubUrl(connectUrl);
  const installHref = parseGitHubUrl(installUrl);
  return (
    <div data-testid="workspace-repository-install" className={`${panel} p-4`}>
      <h4 className={sectionTitle}>{t("install.heading")}</h4>
      <p className={`mt-1.5 ${prose}`}>{t("install.body")}</p>
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
  const t = useTranslations("workspaceSettings.mainRepository");
  const failureText = useWorkspaceSettingsFailure();
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

/** A repository is bound: what it is, where `.oxagen/` is read from, and why this is not the place to change it. */
function BoundRepositoryPanel({
  repository,
  manageUrl,
}: {
  repository: NonNullable<WorkspaceRepository["repository"]>;
  manageUrl: string | null;
}) {
  const t = useTranslations("workspaceSettings.mainRepository");
  const href = parseGitHubUrl(repository.htmlUrl);
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
      <p className={`mt-3 ${prose}`}>{t("bound.fixed")}</p>
      <ManageLink manageUrl={manageUrl} />
    </div>
  );
}

/** When the binding was written, as a date a person reads; the machine value stays in `dateTime`. */
function BoundAt({ iso }: { iso: string }) {
  const t = useTranslations("workspaceSettings.mainRepository");
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
  const t = useTranslations("workspaceSettings.mainRepository");
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
  const t = useTranslations("workspaceSettings.mainRepository");
  const failureText = useWorkspaceSettingsFailure();
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
    return (
      <FormAlert testId="workspace-repositories-failure">
        {failureText(listing.failure)}
      </FormAlert>
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
    const chosen = repositories.find((repository) => repository.id === picked);
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
