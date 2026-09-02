"use client";

/**
 * repos-client.tsx — the Workbench → Repos table + header actions.
 *
 * Renders every GitHub-typed connection ("repo") with sync status (from
 * repo.metrics, degraded to the connection's own status/lastSyncAt when
 * metrics fails for a row), row actions (Sync/Pause-Resume/Configure), and
 * header actions (Create repo, Fork, Connect GitHub App, Edit file & open
 * PR). "Open PRs" and "CI status" columns link into the repo detail page
 * instead of showing a count — there is no repo.pr.list / repo branch-list
 * capability today (see the builder's final report), so this view never
 * fabricates a number it can't back with real data.
 */

import * as React from "react";
import Link from "next/link";
import {
  GitBranch,
  GitFork,
  Plus,
  RefreshCw,
  Settings2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusDot } from "@/components/ui/status-dot";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { workspace } from "@/lib/routes";
import { parseRepoSlug } from "@/lib/workbench/repo-slug";
import type { RepoRow } from "@/lib/workbench/repos";
import { timeAgo } from "@/components/activity/format";
import {
  refreshReposAction,
  syncRepoAction,
  pauseRepoAction,
  resumeRepoAction,
} from "./actions";
import {
  CreateRepoDrawer,
  ForkRepoDrawer,
  ConfigureRepoDrawer,
  EditFileLauncherDrawer,
} from "./repo-drawers";
import { GithubAppStatusAction } from "./github-app-status-action";

export interface ReposClientProps {
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
  initialRepos: RepoRow[];
  unavailable: boolean;
}

type ConnStatus = RepoRow["status"];

/** Pure status → { label, dot } mapping. Exported for unit testing. */
export function repoStatusDisplay(
  status: ConnStatus,
  healthStatus: RepoRow["healthStatus"],
): { label: string; dot: "success" | "warning" | "error" | "neutral" } {
  switch (status) {
    case "pending_setup":
      return { label: "Setup incomplete", dot: "warning" };
    case "connected":
      if (healthStatus === "errored") return { label: "Error", dot: "error" };
      if (healthStatus === "degraded")
        return { label: "Degraded", dot: "warning" };
      return { label: "Syncing", dot: "success" };
    case "paused":
      return { label: "Paused", dot: "neutral" };
    case "error":
      return { label: "Error", dot: "error" };
    case "deleting":
      return { label: "Deleting", dot: "neutral" };
    case "deleted":
      return { label: "Deleted", dot: "neutral" };
    default:
      return { label: status, dot: "neutral" };
  }
}

export function ReposClient({
  orgSlug,
  workspaceSlug,
  canManage,
  initialRepos,
  unavailable,
}: ReposClientProps) {
  const { add: toast } = useToast();
  const [repos, setRepos] = React.useState<RepoRow[]>(initialRepos);
  // The server render's failure flag seeds client state rather than being read
  // directly, so a successful Refresh/retry actually clears the error card —
  // reading the prop meant the ErrorState stuck forever once it appeared.
  const [loadFailed, setLoadFailed] = React.useState(unavailable);
  const [rowBusy, setRowBusy] = React.useState<
    Record<string, string | undefined>
  >({});
  const [rowErrors, setRowErrors] = React.useState<
    Record<string, string | undefined>
  >({});
  const [refreshing, setRefreshing] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [forkOpen, setForkOpen] = React.useState(false);
  const [editLauncherOpen, setEditLauncherOpen] = React.useState(false);
  const [configureTarget, setConfigureTarget] = React.useState<RepoRow | null>(
    null,
  );

  const scope = { orgSlug, workspaceSlug };

  const refresh = React.useCallback(async () => {
    setRefreshing(true);
    const res = await refreshReposAction(scope);
    if (res.ok) {
      setRepos(res.repos);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgSlug, workspaceSlug]);

  async function handleSync(row: RepoRow) {
    setRowBusy((p) => ({ ...p, [row.publicId]: "sync" }));
    setRowErrors((p) => ({ ...p, [row.publicId]: undefined }));
    const res = await syncRepoAction({
      ...scope,
      repoId: row.publicId,
      mode: "incremental",
    });
    setRowBusy((p) => ({ ...p, [row.publicId]: undefined }));
    if (!res.ok) {
      setRowErrors((p) => ({ ...p, [row.publicId]: res.error }));
      toast({ title: "Sync failed", description: res.error, type: "error" });
      return;
    }
    toast({ title: "Sync queued", description: `Job ${res.result.jobId}` });
    void refresh();
  }

  async function handlePauseResume(row: RepoRow) {
    const isPaused = row.status === "paused";
    setRowBusy((p) => ({
      ...p,
      [row.publicId]: isPaused ? "resume" : "pause",
    }));
    setRowErrors((p) => ({ ...p, [row.publicId]: undefined }));
    const res = isPaused
      ? await resumeRepoAction({ ...scope, repoId: row.publicId })
      : await pauseRepoAction({ ...scope, repoId: row.publicId });
    setRowBusy((p) => ({ ...p, [row.publicId]: undefined }));
    if (!res.ok) {
      setRowErrors((p) => ({ ...p, [row.publicId]: res.error }));
      toast({
        title: isPaused ? "Resume failed" : "Pause failed",
        description: res.error,
        type: "error",
      });
      return;
    }
    toast({ title: isPaused ? "Repo resumed" : "Repo paused" });
    void refresh();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="repos-client">
      {/* Header actions only make sense once repos exist — Refresh / Edit /
          Fork are all inoperable with zero repos, so we hide the whole toolbar
          in the empty state and surface the guided actions (Connect, Create)
          inside the empty-state card instead. */}
      {repos.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <GithubAppStatusAction
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
                disabled={refreshing}
                data-testid="repos-refresh-btn"
              >
                <RefreshCw
                  className={refreshing ? "animate-spin" : undefined}
                  aria-hidden="true"
                />
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditLauncherOpen(true)}
                data-testid="repos-edit-file-btn"
              >
                <Sparkles aria-hidden="true" />
                Edit file &amp; open PR
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setForkOpen(true)}
                data-testid="repos-fork-btn"
              >
                <GitFork aria-hidden="true" />
                Fork
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateOpen(true)}
                data-testid="repos-create-btn"
              >
                <Plus aria-hidden="true" />
                Create repo
              </Button>
            </div>
          )}
        </div>
      )}

      {loadFailed ? (
        <ErrorState
          title="Couldn't load repos"
          description="Failed to list GitHub connections for this workspace. Try refreshing."
          retry={() => void refresh()}
        />
      ) : repos.length === 0 ? (
        <EmptyState
          icon={<GitBranch />}
          title="No repos connected"
          description="Install the Oxagen GitHub App, then connect a repository, to see it here."
          variant="dashed"
          data-testid="repos-empty-state"
          action={
            <>
              {/* Guided primary: connect the GitHub App (filled). Create repo
                  sits beside it as the secondary path. */}
              <GithubAppStatusAction
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                connectVariant="default"
              />
              {canManage && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateOpen(true)}
                  data-testid="repos-empty-create-btn"
                >
                  <Plus aria-hidden="true" />
                  Create repo
                </Button>
              )}
            </>
          }
        />
      ) : (
        <Table data-testid="repos-table">
          <TableHeader>
            <TableRow>
              <TableHead>Repo</TableHead>
              <TableHead>Sync status</TableHead>
              <TableHead>Last index</TableHead>
              <TableHead>Open PRs</TableHead>
              <TableHead>CI status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {repos.map((row) => {
              const slug = parseRepoSlug(row.displayName);
              // repo.metrics uses a coarser status enum (pending_setup/active/
              // paused/failed) than connection.list's six-value status — the
              // Sync status column always reads the connection's own status,
              // which repoStatusDisplay is typed against.
              const display = repoStatusDisplay(row.status, row.healthStatus);
              const lastSyncAt = row.metrics?.lastSyncAt ?? row.lastSyncAt;
              const busy = rowBusy[row.publicId];
              const rowError = rowErrors[row.publicId];
              const detailHref = workspace.workbench.repo(scope, row.publicId);
              const canSync =
                row.status !== "deleting" && row.status !== "deleted";
              const canToggle =
                row.status === "connected" || row.status === "paused";

              return (
                <React.Fragment key={row.publicId}>
                  <TableRow data-testid={`repo-row-${row.publicId}`}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <Link
                          href={detailHref}
                          className="font-medium text-foreground hover:underline"
                          data-testid={`repo-link-${row.publicId}`}
                        >
                          {slug
                            ? `${slug.owner}/${slug.repo}`
                            : row.displayName}
                        </Link>
                        <CopyableId value={row.publicId} label="ID" max={14} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5">
                        <StatusDot
                          status={display.dot}
                          pulse={display.dot === "success"}
                        />
                        <span className="text-sm text-foreground">
                          {display.label}
                        </span>
                      </span>
                      {row.metricsError && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Metrics unavailable — showing connection status only.
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {lastSyncAt ? timeAgo(lastSyncAt) : "Never"}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        href={`${detailHref}?tab=pulls`}
                        className="text-primary hover:underline"
                      >
                        View →
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        href={`${detailHref}?tab=pulls`}
                        className="text-primary hover:underline"
                      >
                        View →
                      </Link>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1.5">
                        {canManage && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!canSync || busy !== undefined}
                              onClick={() => void handleSync(row)}
                              data-testid={`repo-sync-${row.publicId}`}
                            >
                              {busy === "sync" ? "Syncing…" : "Sync now"}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!canToggle || busy !== undefined}
                              onClick={() => void handlePauseResume(row)}
                              data-testid={`repo-pause-resume-${row.publicId}`}
                            >
                              {row.status === "paused"
                                ? busy === "resume"
                                  ? "Resuming…"
                                  : "Resume"
                                : busy === "pause"
                                  ? "Pausing…"
                                  : "Pause"}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfigureTarget(row)}
                              data-testid={`repo-configure-${row.publicId}`}
                              aria-label={`Configure ${row.displayName}`}
                            >
                              <Settings2 aria-hidden="true" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {rowError && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="py-1.5">
                        <p
                          className="text-xs text-destructive"
                          data-testid={`repo-row-error-${row.publicId}`}
                        >
                          {rowError}
                        </p>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CreateRepoDrawer
        open={createOpen}
        onOpenChange={setCreateOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
      <ForkRepoDrawer
        open={forkOpen}
        onOpenChange={setForkOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
      />
      <ConfigureRepoDrawer
        target={configureTarget}
        onOpenChange={(open) => !open && setConfigureTarget(null)}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        onSaved={() => void refresh()}
      />
      <EditFileLauncherDrawer
        open={editLauncherOpen}
        onOpenChange={setEditLauncherOpen}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        repos={repos}
      />
    </div>
  );
}
