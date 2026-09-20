"use client";
// The Repositories page (mockup `pRepos()`; MC spec §10.1, §10.2, §11.2,
// §11.4): where this workspace's files live, who has them on disk, and every
// change Oxagen has proposed to them. One argument runs through all four tabs:
// `.oxagen/` is the workspace's source of truth, it lives in git, and every
// change to it arrives as a pull request.
//
// The page reads on demand through its server actions: the bound repositories
// first (a local read, so it draws while GitHub is down), then what each one
// holds under `.oxagen/` and the Context PRs, both in parallel. Every write on
// the page re-reads all three, so a row never goes on describing a state the
// person has just changed.
//
// States (quality gates): loading replaces the body with a skeleton under the
// header; a refusal to read is the denied state; any other failure is the
// error state with Try again; a workspace that binds nothing yet is the empty
// state, which carries the GitHub setup that binds the main repository.
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type {
  RepositoryChanges,
  RepositoryTree,
  WorkspaceRepositories,
} from "@/data/contracts/repository";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { RouteTabs } from "@/ui/route-tabs";
import {
  readRepositoryChanges,
  readRepositoryTree,
  readWorkspaceRepositories,
} from "./actions";
import {
  LinkRepository,
  ReachableRepositories,
  RepositoryTable,
} from "./bound-repositories";
import { Changes } from "./changes";
import { Configuration } from "./configuration";
import { UNANSWERED, type RepositoriesFailure } from "./failure";
import { InitWizard, PermissionTable, APP_CANNOT } from "./init-wizard";
import { RepositorySetup } from "./main-repository";
import { Explainer, type Load, prose, sectionTitle } from "./parts";
import { RepositoryDialog } from "./repository-dialog";
import type { RepositoryTab } from "./view";
import { ConnectDirectoryDialog, WorkingCopies } from "./working-copies";

/** The roles the signed-in person holds here, lowercased as the viewer carries them. */
export type ViewerRoles = { org: string; workspace: string };

type Trees = Readonly<Record<string, Load<RepositoryTree>>>;

type WizardState = { open: boolean; initial: string | null; opening: number };

export function Repositories({
  org,
  ws,
  wsName,
  tab,
  roles,
}: {
  org: string;
  ws: string;
  wsName: string;
  tab: RepositoryTab;
  /** The signed-in person's roles, which the denied state names. */
  roles: ViewerRoles;
}) {
  const t = useTranslations("repositories.page");
  const navigate = useNavigate();
  const [version, setVersion] = useState(0);
  const [list, setList] = useState<Load<WorkspaceRepositories>>({
    kind: "loading",
  });
  const [changes, setChanges] = useState<Load<RepositoryChanges>>({
    kind: "loading",
  });
  const [trees, setTrees] = useState<Trees>({});
  const [selected, setSelected] = useState<string | null>(null);
  // The binding version `selected` superseded. A production-branch change
  // writes a new version, and the list names the old one until the re-read
  // lands; the dialog stays on that row rather than closing in between.
  const [superseded, setSuperseded] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState>({
    open: false,
    initial: null,
    opening: 0,
  });
  const [connectOpen, setConnectOpen] = useState(false);

  const reread = useCallback(() => {
    setVersion((n) => n + 1);
  }, []);

  useEffect(() => {
    // A cell read through a call: the cleanup writes it, and a call carries no
    // narrowing across the awaits below.
    const live = { current: true };
    const cancelled = () => !live.current;
    const loadChanges = async () => {
      let read;
      try {
        read = await readRepositoryChanges(org, ws);
      } catch {
        read = UNANSWERED;
      }
      if (cancelled()) return;
      setChanges(
        read.ok
          ? { kind: "ready", value: read.value }
          : { kind: "failed", failure: read },
      );
    };
    const loadTree = async (bindingId: string) => {
      let read;
      try {
        read = await readRepositoryTree(org, ws, bindingId);
      } catch {
        read = UNANSWERED;
      }
      if (cancelled()) return;
      setTrees((current) => ({
        ...current,
        [bindingId]: read.ok
          ? { kind: "ready", value: read.value }
          : { kind: "failed", failure: read },
      }));
    };
    const load = async () => {
      // A list already in hand stays on screen while it re-reads after a
      // write: the row that changed is what the person is looking at.
      setList((current) =>
        current.kind === "ready" ? current : { kind: "loading" },
      );
      void loadChanges();
      let read;
      try {
        read = await readWorkspaceRepositories(org, ws);
      } catch {
        read = UNANSWERED;
      }
      if (cancelled()) return;
      if (!read.ok) {
        setList({ kind: "failed", failure: read });
        return;
      }
      setList({ kind: "ready", value: read.value });
      const loading: Record<string, Load<RepositoryTree>> = {};
      for (const row of read.value.repositories)
        loading[row.bindingId] = { kind: "loading" };
      setTrees(loading);
      await Promise.all(
        read.value.repositories.map((row) => loadTree(row.bindingId)),
      );
    };
    void load();
    return () => {
      live.current = false;
    };
  }, [org, ws, version]);

  const openWizard = useCallback((initial: string | null) => {
    setSelected(null);
    setWizard((current) => ({
      open: true,
      initial,
      opening: current.opening + 1,
    }));
  }, []);

  const repositories = list.kind === "ready" ? list.value.repositories : [];
  const openCount = changes.kind === "ready" ? changes.value.open : 0;
  const selectedRow =
    selected === null
      ? null
      : (repositories.find((row) => row.bindingId === selected) ??
        repositories.find((row) => row.bindingId === superseded) ??
        null);
  const loaded = list.kind === "ready" && repositories.length > 0;

  // Exactly one gold action per screen: the header's, except on Working
  // copies, where the tab's own Connect a directory holds it.
  const headerGold = tab !== "working-copies";
  const header = (
    <PageHeader
      title={t("title")}
      eyebrow={t("eyebrow", { workspace: wsName })}
      actions={
        loaded ? (
          <button
            type="button"
            data-testid="repositories-add-oxagen"
            data-touch-target=""
            aria-haspopup="dialog"
            className={headerGold ? buttonPrimary : buttonSecondary}
            onClick={() => {
              openWizard(null);
            }}
          >
            {t("addOxagen")}
          </button>
        ) : null
      }
    />
  );

  let body;
  if (list.kind === "loading") body = <LoadingBody />;
  else if (list.kind === "failed")
    body =
      list.failure.reason === "denied" ? (
        <DeniedBody org={org} ws={ws} failure={list.failure} roles={roles} />
      ) : (
        <ErrorBody failure={list.failure} onRetry={reread} />
      );
  else if (repositories.length === 0)
    body = <EmptyBody org={org} ws={ws} onChanged={reread} />;
  else {
    const main = repositories.find((row) => row.role === "main") ?? null;
    const ungoverned = repositories.filter((row) => {
      const tree = trees[row.bindingId];
      return (
        row.role === "linked" &&
        tree?.kind === "ready" &&
        tree.value.head !== null &&
        !tree.value.oxagen.present
      );
    });
    body = (
      <>
        <RouteTabs
          label={t("tabs.label")}
          tabs={[
            {
              to: routes.repositories(org, ws),
              label: t("tabs.repositories", { count: repositories.length }),
              current: tab === "repositories",
            },
            {
              to: routes.repositories(org, ws, "working-copies"),
              label: t("tabs.workingCopies"),
              current: tab === "working-copies",
            },
            {
              to: routes.repositories(org, ws, "changes"),
              label:
                openCount > 0
                  ? t("tabs.changesOpen", { count: openCount })
                  : t("tabs.changes"),
              current: tab === "changes",
            },
            {
              to: routes.repositories(org, ws, "configuration"),
              label: t("tabs.configuration"),
              current: tab === "configuration",
            },
          ]}
        />
        <div className="mt-5">
          {tab === "repositories" ? (
            <div className="flex flex-col gap-5">
              {ungoverned.length === 0 ? null : (
                <p
                  role="note"
                  data-testid="repositories-ungoverned"
                  className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground"
                >
                  {t("ungoverned", {
                    repositories: ungoverned
                      .map((row) => row.fullName)
                      .join(", "),
                  })}
                </p>
              )}
              <RepositoryTable
                org={org}
                ws={ws}
                repositories={repositories}
                trees={trees}
                onOpen={setSelected}
                onChanged={reread}
              />
              <ReachableRepositories
                org={org}
                ws={ws}
                bound={repositories.map((row) => row.fullName)}
                version={version}
                onLinked={reread}
              />
              <LinkRepository org={org} ws={ws} onLinked={reread} />
              <div className="grid gap-4 md:grid-cols-2">
                <Explainer
                  title={t("linking.title")}
                  testId="repositories-linking"
                >
                  <ol className="list-decimal pl-5">
                    <li>{t("linking.branch")}</li>
                    <li>{t("linking.events")}</li>
                    <li>{t("linking.issues")}</li>
                    <li>{t("linking.graph")}</li>
                  </ol>
                </Explainer>
                <PermissionsExplainer />
              </div>
              <section
                aria-labelledby="repositories-setup"
                className="border-t border-border pt-5"
              >
                <h2 id="repositories-setup" className="sr-only">
                  {t("setup")}
                </h2>
                <RepositorySetup org={org} ws={ws} onChanged={reread} />
              </section>
            </div>
          ) : tab === "working-copies" ? (
            <div className="flex flex-col gap-4">
              <div>
                <button
                  type="button"
                  data-testid="working-copies-connect"
                  data-touch-target=""
                  aria-haspopup="dialog"
                  className={buttonPrimary}
                  onClick={() => {
                    setConnectOpen(true);
                  }}
                >
                  {t("connectDirectory")}
                </button>
              </div>
              <WorkingCopies />
            </div>
          ) : tab === "changes" ? (
            <Changes org={org} ws={ws} changes={changes} />
          ) : (
            <Configuration
              mainFullName={main?.fullName ?? null}
              tree={main === null ? undefined : trees[main.bindingId]}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <div data-testid="repositories-page" data-state={pageState(list)}>
      {header}
      {body}
      <RepositoryDialog
        org={org}
        ws={ws}
        repository={selectedRow}
        tree={selectedRow === null ? undefined : trees[selectedRow.bindingId]}
        onClose={() => {
          setSelected(null);
          setSuperseded(null);
        }}
        onChanged={(bindingId) => {
          setSuperseded(selected);
          setSelected(bindingId);
          reread();
        }}
        onAddOxagen={openWizard}
        onSeeChanges={() => {
          setSelected(null);
          navigate.push(routes.repositories(org, ws, "changes"));
        }}
      />
      <InitWizard
        key={wizard.opening}
        org={org}
        ws={ws}
        wsName={wsName}
        open={wizard.open}
        initial={wizard.initial}
        repositories={repositories}
        trees={trees}
        onClose={() => {
          setWizard((current) => ({ ...current, open: false }));
        }}
        onOpened={reread}
      />
      <ConnectDirectoryDialog
        open={connectOpen}
        onClose={() => {
          setConnectOpen(false);
        }}
      />
    </div>
  );
}

function pageState(
  list: Load<WorkspaceRepositories>,
): "loading" | "denied" | "error" | "empty" | "loaded" {
  if (list.kind === "loading") return "loading";
  if (list.kind === "failed")
    return list.failure.reason === "denied" ? "denied" : "error";
  return list.value.repositories.length === 0 ? "empty" : "loaded";
}

/** The permissions the App needs, writes included, and what they still do not buy. */
function PermissionsExplainer() {
  const t = useTranslations("repositories.permissions");
  return (
    <Explainer title={t("title")} testId="repositories-permissions">
      <PermissionTable />
      <p className="font-medium text-foreground">{t("cannotHeading")}</p>
      <ul className="list-disc pl-5">
        {APP_CANNOT.map((key) => (
          <li key={key}>{t(`cannot.${key}`)}</li>
        ))}
      </ul>
    </Explainer>
  );
}

function LoadingBody() {
  const t = useTranslations("repositories.page");
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="repositories-loading"
      className="flex flex-col gap-3"
    >
      <span className="sr-only">{t("loading")}</span>
      <div className="h-11 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-md bg-muted" />
      <div className="h-24 w-full animate-pulse rounded-md bg-muted" />
    </div>
  );
}

function ErrorBody({
  failure,
  onRetry,
}: {
  failure: RepositoriesFailure;
  onRetry: () => void;
}) {
  const t = useTranslations("repositories.page.error");
  const code = "code" in failure ? failure.code : failure.reason;
  return (
    <section
      role="alert"
      data-testid="repositories-error"
      className="flex max-w-prose flex-col gap-3"
    >
      <h2 className={sectionTitle}>{t("title")}</h2>
      <p className={prose}>
        <code className={mono}>{code}</code>. {t("body")}
      </p>
      <div>
        <button
          type="button"
          data-testid="repositories-retry"
          data-touch-target=""
          className={buttonSecondary}
          onClick={onRetry}
        >
          {t("retry")}
        </button>
      </div>
    </section>
  );
}

function DeniedBody({
  org,
  ws,
  failure,
  roles,
}: {
  org: string;
  ws: string;
  failure: RepositoriesFailure;
  roles: ViewerRoles;
}) {
  const t = useTranslations("repositories.page.denied");
  const permission = "code" in failure ? failure.code : "repository.read";
  return (
    <section
      data-testid="repositories-denied"
      className="flex max-w-prose flex-col gap-3"
    >
      <h2 className={sectionTitle}>{t("title")}</h2>
      <p className={prose}>{t("body", { permission, workspace: ws })}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("signedIn")}</dt>
        <dd data-testid="repositories-denied-roles">
          {t("roles", { org: roles.org, workspace: roles.workspace })}
        </dd>
        <dt className="text-muted-foreground">{t("needed")}</dt>
        <dd>
          <code className={mono}>
            {permission} · {ws}
          </code>
        </dd>
      </dl>
      <p className={prose}>{t("ask")}</p>
      <div>
        <SafeLink
          to={routes.fleet(org, ws)}
          data-testid="repositories-back-to-fleet"
          data-touch-target=""
          className={buttonSecondary}
        >
          {t("back")}
        </SafeLink>
      </div>
    </section>
  );
}

function EmptyBody({
  org,
  ws,
  onChanged,
}: {
  org: string;
  ws: string;
  onChanged: () => void;
}) {
  const t = useTranslations("repositories.page.empty");
  return (
    <section data-testid="repositories-empty" className="flex flex-col gap-4">
      <div className="max-w-prose">
        <h2 className={sectionTitle}>{t("title")}</h2>
        <p className={`mt-1 ${prose}`}>{t("body")}</p>
      </div>
      <RepositorySetup org={org} ws={ws} onChanged={onChanged} />
    </section>
  );
}
