"use client";
// The Repositories page (mockup `pRepos()`; mockups/pages/repositories.md; MC
// spec §10.1, §10.2, §11.2, §11.4): where this workspace's files live, who has
// them on disk, and every change Oxagen has proposed to them. One argument
// runs through all four tabs: `.oxagen/` is the workspace's source of truth,
// it lives in git, and every change to it arrives as a pull request.
//
// The page reads on demand through its server actions: the bound
// repositories first (a local read, so it draws while GitHub is down), then
// the repositories the installation reaches, what each bound one holds under
// `.oxagen/`, and the Context PRs, in parallel. Every write re-reads them all,
// so a row never goes on describing a state the person has just changed.
//
// States (quality gates): loading replaces the body with the skeleton; a
// refusal to read is the denied state; any other failure is the error state;
// a workspace that binds nothing yet is the empty state, whose one gold action
// opens the init wizard. Each replaces the header and tabs too, and never the
// shell.
//
// Exactly one gold action per screen. The header's Add Oxagen to a repository
// holds it, except on Working copies, where Connect a directory does, and on a
// selected pull request whose every check passed, where Merge pull request
// does. A pull request that cannot merge never takes the gold.
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type {
  InstallationRepositories,
  RepositoryChanges,
  RepositoryTree,
  WorkspaceRepositories,
} from "@/data/contracts/repository";
import type { ActionResult } from "@/server/kernel";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { useNavigate } from "@/ui/navigation";
import { PageHeader } from "@/ui/page-header";
import { RouteTabs } from "@/ui/route-tabs";
import {
  listInstallationRepositories,
  readRepositoryChanges,
  readRepositoryTree,
  readWorkspaceRepositories,
} from "./actions";
import { ChangeDetail, type Closer } from "./change-detail";
import { Changes } from "./changes";
import { Configuration } from "./configuration";
import { UNANSWERED } from "./failure";
import { InitWizard } from "./init-wizard";
import type { Load } from "./parts";
import { RepositoriesTab } from "./repositories-tab";
import { RepositoryDialog } from "./repository-dialog";
import { DeniedBody, EmptyBody, ErrorBody, LoadingBody } from "./states";
import { UnlinkDialog } from "./unlink-dialog";
import {
  type RepositoryRow,
  type RepositoryView,
  repositoryRows,
} from "./view";
import { ConnectDirectoryDialog, WorkingCopies } from "./working-copies";

/** The signed-in person, as the denied state and the close comment name them. */
export type RepositoriesViewer = Closer & { role: string };

type Trees = Readonly<Record<string, Load<RepositoryTree>>>;

type WizardState = { open: boolean; initial: string | null; opening: number };

/** The codes that mean GitHub is not connected yet, so the wizard connects it first. */
const UNCONNECTED = new Set(["github_not_connected", "github_not_authorized"]);

export function Repositories({
  org,
  ws,
  orgName,
  wsName,
  view,
  viewer,
  returning = false,
}: {
  org: string;
  ws: string;
  orgName: string;
  wsName: string;
  view: RepositoryView;
  viewer: RepositoriesViewer;
  /** The person is back from GitHub's install flow; the wizard reopens on its first step. */
  returning?: boolean;
}) {
  const t = useTranslations("repositories.page");
  const navigate = useNavigate();
  const format = useFormatter();
  const [version, setVersion] = useState(0);
  const [list, setList] = useState<Load<WorkspaceRepositories>>({
    kind: "loading",
  });
  const [failedAt, setFailedAt] = useState<Date | null>(null);
  const [reachable, setReachable] = useState<Load<InstallationRepositories>>({
    kind: "loading",
  });
  const [changes, setChanges] = useState<Load<RepositoryChanges>>({
    kind: "loading",
  });
  const [trees, setTrees] = useState<Trees>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<RepositoryRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [wizard, setWizard] = useState<WizardState>({
    open: returning,
    initial: null,
    opening: 0,
  });
  const [connectOpen, setConnectOpen] = useState(false);
  const [mergeable, setMergeable] = useState(false);

  const reread = useCallback(() => {
    setVersion((n) => n + 1);
  }, []);

  useEffect(() => {
    // A cell read through a call: the cleanup writes it, and a call carries no
    // narrowing across the awaits below.
    const live = { current: true };
    const cancelled = () => !live.current;
    const settle = async <T,>(
      read: () => Promise<ActionResult<T>>,
      write: (value: Load<T>) => void,
    ) => {
      let result: ActionResult<T>;
      try {
        result = await read();
      } catch {
        result = UNANSWERED;
      }
      if (cancelled()) return;
      write(
        result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "failed", failure: result },
      );
    };
    const loadTree = (bindingId: string) =>
      settle(
        () => readRepositoryTree(org, ws, bindingId),
        (value) => {
          setTrees((current) => ({ ...current, [bindingId]: value }));
        },
      );
    const load = async () => {
      // A list already in hand stays on screen while it re-reads after a
      // write: the row that changed is what the person is looking at.
      setList((current) =>
        current.kind === "ready" ? current : { kind: "loading" },
      );
      void settle(() => readRepositoryChanges(org, ws), setChanges);
      void settle(() => listInstallationRepositories(org, ws), setReachable);
      let read;
      try {
        read = await readWorkspaceRepositories(org, ws);
      } catch {
        read = UNANSWERED;
      }
      if (cancelled()) return;
      if (!read.ok) {
        setFailedAt(new Date());
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

  const bound = list.kind === "ready" ? list.value.repositories : [];
  const reached = reachable.kind === "ready" ? reachable.value : null;
  const rows = repositoryRows(bound, trees, reached?.repositories ?? []);
  const main = rows.find((row) => row.role === "main") ?? null;
  const selectedRow =
    selected === null
      ? null
      : (rows.find((row) => row.fullName === selected) ?? null);
  const connectNeeded =
    reachable.kind === "failed" &&
    "code" in reachable.failure &&
    UNCONNECTED.has(reachable.failure.code);
  const openCount = changes.kind === "ready" ? changes.value.open : 0;
  const onChange = view.tab === "changes" && view.change !== null;
  const headerGold = view.tab !== "working-copies" && !(onChange && mergeable);

  let body;
  if (list.kind === "loading") body = <LoadingBody />;
  else if (list.kind === "failed")
    body =
      list.failure.reason === "denied" ? (
        <DeniedBody
          org={org}
          orgName={orgName}
          ws={ws}
          failure={list.failure}
          viewer={viewer}
        />
      ) : (
        <ErrorBody
          failure={list.failure}
          readAt={format.dateTime(failedAt ?? new Date(), {
            dateStyle: "medium",
            timeStyle: "medium",
          })}
          onRetry={reread}
        />
      );
  else if (bound.length === 0)
    body = (
      <EmptyBody
        onAddOxagen={() => {
          openWizard(null);
        }}
      />
    );
  else
    body = (
      <>
        <PageHeader
          title={t("title")}
          eyebrow={wsName}
          description={t("subtitle")}
          actions={
            <button
              type="button"
              data-testid="repositories-add-oxagen"
              data-touch-target=""
              data-gold={headerGold ? "" : undefined}
              aria-haspopup="dialog"
              className={headerGold ? buttonPrimary : buttonSecondary}
              onClick={() => {
                openWizard(null);
              }}
            >
              {t("addOxagen")}
            </button>
          }
        />
        <RouteTabs
          label={t("tabs.label")}
          tabs={[
            {
              to: routes.repositories(org, ws),
              label: t("tabs.repositories"),
              count: bound.length,
              current: view.tab === "repositories",
            },
            {
              to: routes.repositories(org, ws, "working-copies"),
              label: t("tabs.workingCopies"),
              current: view.tab === "working-copies",
            },
            {
              to: routes.repositories(org, ws, "changes"),
              label: t("tabs.changes"),
              ...(openCount > 0 ? { count: openCount } : {}),
              current: view.tab === "changes",
            },
            {
              to: routes.repositories(org, ws, "configuration"),
              label: t("tabs.configuration"),
              current: view.tab === "configuration",
            },
          ]}
        />
        <div className="mt-4">
          {notice === null ? null : (
            <p
              role="status"
              data-testid="repositories-notice"
              className="mb-3.5 text-[13px] text-foreground"
            >
              {notice}
            </p>
          )}
          {view.tab === "repositories" ? (
            <RepositoriesTab
              rows={rows}
              reachableUnread={reachable.kind === "failed" && !connectNeeded}
              truncated={reached?.truncated ?? false}
              onOpen={setSelected}
              onAddOxagen={openWizard}
            />
          ) : view.tab === "working-copies" ? (
            <WorkingCopies
              primary
              onConnect={() => {
                setConnectOpen(true);
              }}
            />
          ) : view.tab === "changes" ? (
            view.change === null ? (
              <Changes
                changes={changes}
                onOpen={(proposalId) => {
                  navigate.push(
                    routes.repositories(org, ws, "changes", proposalId),
                  );
                }}
              />
            ) : (
              <ChangeDetail
                key={view.change}
                org={org}
                ws={ws}
                proposalId={view.change}
                row={
                  changes.kind === "ready"
                    ? (changes.value.changes.find(
                        (change) => change.proposalId === view.change,
                      ) ?? null)
                    : null
                }
                closer={viewer}
                onBack={() => {
                  navigate.push(routes.repositories(org, ws, "changes"));
                }}
                onMergeable={setMergeable}
                onChanged={reread}
              />
            )
          ) : (
            <Configuration
              mainFullName={main?.fullName ?? null}
              tree={main === null ? undefined : (main.tree ?? undefined)}
            />
          )}
        </div>
      </>
    );

  return (
    <div
      data-testid="repositories-page"
      data-state={pageState(list)}
      className="flex flex-col gap-4"
    >
      {body}
      <RepositoryDialog
        org={org}
        ws={ws}
        workspace={wsName}
        mainFullName={main?.fullName ?? null}
        row={selectedRow}
        onClose={() => {
          setSelected(null);
        }}
        onChanged={reread}
        onUnlink={(row) => {
          setSelected(null);
          setUnlinking(row);
        }}
        onAddOxagen={openWizard}
        onSeeChanges={() => {
          setSelected(null);
          navigate.push(routes.repositories(org, ws, "changes"));
        }}
      />
      <UnlinkDialog
        org={org}
        ws={ws}
        workspace={wsName}
        row={unlinking}
        onClose={() => {
          setUnlinking(null);
        }}
        onUnlinked={(message) => {
          setUnlinking(null);
          setNotice(message);
          reread();
        }}
      />
      <InitWizard
        key={wizard.opening}
        org={org}
        ws={ws}
        wsName={wsName}
        open={wizard.open}
        initial={wizard.initial}
        rows={rows}
        connectNeeded={connectNeeded}
        onClose={() => {
          setWizard((current) => ({ ...current, open: false }));
        }}
        onOpened={reread}
      />
      <ConnectDirectoryDialog
        org={org}
        ws={ws}
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
