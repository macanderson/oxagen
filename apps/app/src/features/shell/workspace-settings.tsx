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
function SettingsQuery({
  onRequested,
}: {
  onRequested: (acknowledgeConnected: boolean) => void;
}) {
  const params = useSearchParams();
  const pathname = usePathname();
  const navigate = useNavigate();
  useEffect(() => {
    if (params.get("settings") !== "repository") return;
    onRequested(params.get("github") === "connected");
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
  const [connectedJustNow, setConnectedJustNow] = useState(false);

  const onRequested = useCallback(
    (acknowledgeConnected: boolean) => {
      setConnectedJustNow(acknowledgeConnected);
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
          connectedJustNow={connectedJustNow}
        />
      </SheetDialog>
    </>
  );
}

function MainRepositoryPanel({
  org,
  ws,
  open,
  connectedJustNow,
}: {
  org: string;
  ws: string;
  open: boolean;
  connectedJustNow: boolean;
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
    let live = true;
    setSettings({ kind: "loading" });
    setListing(null);
    const load = async () => {
      let record;
      try {
        record = await readWorkspaceRepository(org, ws);
      } catch {
        record = UNANSWERED;
      }
      if (!live) return;
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
      if (!live) return;
      setListing(
        repositories.ok
          ? { kind: "ready", value: repositories.value }
          : { kind: "failed", failure: repositories },
      );
    };
    void load();
    return () => {
      live = false;
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
      {connectedJustNow ? (
        <p
          role="status"
          data-testid="workspace-github-connected"
          className="mt-3 text-sm text-foreground"
        >
          {t("connected")}
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
