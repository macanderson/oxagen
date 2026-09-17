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
  bindWorkspaceRepository,
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
 * The query the API's OAuth callback sends a person back on:
 * `?settings=repository&github=connected` after a `returnTo=settings` install.
 * The dialog opens on it and the params are dropped, so a reload does not
 * re-open a panel the person has closed. Read in its own component because
 * `useSearchParams` needs a Suspense boundary around whatever reads it.
 */
/** What the install leg came back saying; null when it said nothing. */
type InstallAcknowledgement = "connected" | "failed" | null;

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
    // Three outcomes, matching GITHUB_ACK in the API's callback: `connected`
    // when an installation was verified and attached, `failed` when one was
    // claimed and declined, and nothing at all on the identity-only leg that
    // had no installation to attach. Any value this does not know becomes
    // null — no acknowledgement is the only safe default, since the one thing
    // worse than saying nothing is announcing a connection that did not happen.
    const github = params.get("github");
    onRequested(
      github === "connected"
        ? "connected"
        : github === "failed"
          ? "failed"
          : null,
    );
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
      // The list is a live GitHub call, so it is made only in the one state
      // that uses it: an installation is attached and nothing is bound yet.
      if (record.value.repository !== null || !record.value.github.connected)
        return;
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
      {acknowledgement === "connected" ? (
        <p
          role="status"
          data-testid="workspace-github-connected"
          className="mt-3 text-sm text-foreground"
        >
          {t("connected")}
        </p>
      ) : acknowledgement === "failed" ? (
        // A declined install is said out loud. The panel below will draw the
        // install door again, and without this the person would be looking at
        // the same button they just pressed with nothing explaining why they
        // are back at it.
        <p
          role="status"
          data-testid="workspace-github-failed"
          className="mt-3 text-sm text-foreground"
        >
          {t("installRefused")}
        </p>
      ) : null}
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
          <InstallPanel installUrl={settings.value.github.installUrl} />
        )}
      </div>
    </section>
  );
}

/** No installation is attached: the App's install door, or the honest reason there is none. */
function InstallPanel({ installUrl }: { installUrl: string | null }) {
  const t = useTranslations("workspaceSettings.mainRepository");
  const href = parseGitHubUrl(installUrl);
  return (
    <div data-testid="workspace-repository-install" className={`${panel} p-4`}>
      <h4 className={sectionTitle}>{t("install.heading")}</h4>
      <p className={`mt-1.5 ${prose}`}>{t("install.body")}</p>
      {href === null ? (
        <p
          data-testid="workspace-github-unconfigured"
          className={`mt-3 ${prose}`}
        >
          {t("unconfigured")}
        </p>
      ) : (
        <GitHubLink
          to={href}
          data-testid="workspace-github-install"
          data-touch-target=""
          className={`mt-3 ${buttonSecondary}`}
        >
          {t("install.action")}
        </GitHubLink>
      )}
    </div>
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
