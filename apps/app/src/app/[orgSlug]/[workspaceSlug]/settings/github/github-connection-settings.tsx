"use client";

/**
 * github-connection-settings.tsx — Workspace Settings → GitHub panel.
 *
 * Connects the workspace to the Oxagen GitHub App (1 workspace = 1 app install)
 * and shows which GitHub orgs/installations the connection grants access to. The
 * App can be installed on the same GitHub org across any combination of Oxagen
 * orgs and workspaces, so this lists every installation the workspace's token can
 * reach. Repo selection for ingestion happens on the Sources tab — this panel
 * only owns the connect/install lifecycle.
 */

import * as React from "react";
import {
  GithubIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import {
  fetchGithubStatus,
  type GithubStatusResponse,
  type Installation,
} from "@/lib/github";
import { workspace } from "@/lib/routes";

export interface GithubConnectionSettingsProps {
  orgSlug: string;
  workspaceSlug: string;
  /** Owner/admin — only managers may connect, reconnect, or manage access. */
  canManage: boolean;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; status: GithubStatusResponse };

export function GithubConnectionSettings({
  orgSlug,
  workspaceSlug,
  canManage,
}: GithubConnectionSettingsProps) {
  const [state, setState] = React.useState<LoadState>({ phase: "loading" });
  const [refreshing, setRefreshing] = React.useState(false);
  // True right after returning from the GitHub install redirect (?github_connected=1).
  const [justConnected, setJustConnected] = React.useState(false);

  const load = React.useCallback(
    async (mode: "initial" | "refresh", signal?: AbortSignal) => {
      if (mode === "refresh") setRefreshing(true);
      else setState({ phase: "loading" });
      try {
        const status = await fetchGithubStatus(orgSlug, workspaceSlug, signal);
        if (signal?.aborted) return;
        setState({ phase: "ready", status });
      } catch (e) {
        if (signal?.aborted) return;
        setState({
          phase: "error",
          message:
            e instanceof Error ? e.message : "Failed to load GitHub status",
        });
      } finally {
        setRefreshing(false);
      }
    },
    [orgSlug, workspaceSlug],
  );

  // Initial load. Also detect the post-install return so we can show a success
  // banner and strip the query param without a navigation.
  React.useEffect(() => {
    const controller = new AbortController();
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("github_connected") === "1") {
        setJustConnected(true);
        params.delete("github_connected");
        const qs = params.toString();
        window.history.replaceState(
          null,
          "",
          window.location.pathname + (qs ? `?${qs}` : ""),
        );
      }
    }
    void load("initial", controller.signal);
    return () => controller.abort();
  }, [load]);

  // Start (or re-run) the GitHub connection via the identity (OAuth authorize)
  // leg. This always returns to our callback with code+state — even when the App
  // is already installed on the target org — so a second Oxagen tenant can
  // establish its own token. Fall back to installUrl if the server predates the
  // identityUrl field. Navigating same-tab keeps the signed OAuth state intact;
  // the callback returns to this page.
  const connect = React.useCallback(() => {
    if (state.phase !== "ready") return;
    window.location.href = state.status.identityUrl ?? state.status.installUrl;
  }, [state]);

  const sourcesHref = workspace.knowledge.sources({ orgSlug, workspaceSlug });

  return (
    <div
      className="flex max-w-2xl flex-col gap-5"
      data-testid="github-settings"
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <GithubIcon
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold text-foreground">GitHub</p>
          <p className="text-xs text-muted-foreground">
            Connect this workspace to GitHub with the Oxagen GitHub App. One
            install per workspace gives every agent here access to the
            repositories you choose to ingest. After connecting, pick
            repositories from{" "}
            <a href={sourcesHref} className="text-primary hover:underline">
              Knowledge → Sources
            </a>
            .
          </p>
        </div>
      </div>

      {justConnected && (
        <div
          className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2 text-xs font-medium text-success"
          data-testid="github-connected-banner"
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          GitHub App connected.
        </div>
      )}

      {state.phase === "loading" ? (
        <div
          className="flex h-32 items-center justify-center rounded-lg border border-border/60 bg-card/50"
          data-testid="github-settings-loading"
        >
          <RefreshCwIcon
            className="h-4 w-4 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
        </div>
      ) : state.phase === "error" ? (
        <div
          className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3"
          data-testid="github-settings-error"
        >
          <p className="flex items-center gap-2 text-xs font-medium text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            {state.message}
          </p>
          <button
            type="button"
            className="max-md:min-h-11 rounded-md border border-border/60 bg-card px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            onClick={() => void load("refresh")}
          >
            Retry
          </button>
        </div>
      ) : state.status.connected ? (
        <ConnectedView
          status={state.status}
          canManage={canManage}
          refreshing={refreshing}
          onRefresh={() => void load("refresh")}
          onReconnect={connect}
        />
      ) : (
        <DisconnectedView canManage={canManage} onConnect={connect} />
      )}
    </div>
  );
}

// ── Disconnected ────────────────────────────────────────────────────────────

function DisconnectedView({
  canManage,
  onConnect,
}: {
  canManage: boolean;
  onConnect: () => void;
}) {
  return (
    <div
      className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border/60 bg-card/50 px-8 py-10 text-center"
      data-testid="github-disconnected"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <GithubIcon className="h-6 w-6 text-foreground" aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">
          GitHub is not connected
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Install the Oxagen GitHub App to grant this workspace access to your
          repositories. You choose exactly which orgs and repos the App can
          read.
        </p>
      </div>
      {canManage ? (
        <button
          type="button"
          className="flex max-md:min-h-11 items-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition-colors hover:bg-foreground/90"
          onClick={onConnect}
          data-testid="github-connect-btn"
        >
          <GithubIcon className="h-4 w-4" aria-hidden="true" />
          Connect GitHub
        </button>
      ) : (
        <p className="text-xs text-muted-foreground">
          Ask a workspace owner or admin to connect GitHub.
        </p>
      )}
    </div>
  );
}

// ── Connected ───────────────────────────────────────────────────────────────

function ConnectedView({
  status,
  canManage,
  refreshing,
  onRefresh,
  onReconnect,
}: {
  status: GithubStatusResponse;
  canManage: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onReconnect: () => void;
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="github-connected">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          Connected
        </span>
        <button
          type="button"
          className="flex max-md:min-h-11 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="github-refresh-btn"
        >
          <RefreshCwIcon
            className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          Refresh
        </button>
      </div>

      {/* Installations the connection grants access to */}
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Installed organizations
        </p>
        {status.installations.length === 0 ? (
          <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
            The App is connected but not installed on any organization yet. Add
            it to an organization below.
          </p>
        ) : (
          <ul
            className="divide-y divide-border/40 overflow-hidden rounded-lg border border-border/60"
            data-testid="github-installations"
          >
            {status.installations.map((inst) => (
              <InstallationRow
                key={inst.id}
                installation={inst}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Manage links */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {canManage && (
          <a
            href={status.installUrl}
            className="flex items-center gap-1 text-[11px] text-primary hover:underline"
            data-testid="github-add-org-link"
          >
            <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
            Add another organization
          </a>
        )}
        <a
          href={status.manageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[11px] text-primary hover:underline"
          data-testid="github-manage-link"
        >
          <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
          Manage GitHub App access
        </a>
        {canManage && (
          <button
            type="button"
            className="inline-flex max-md:min-h-11 items-center text-[11px] text-muted-foreground hover:text-foreground hover:underline"
            onClick={onReconnect}
            data-testid="github-reconnect-btn"
          >
            Reconnect
          </button>
        )}
      </div>
    </div>
  );
}

function InstallationRow({
  installation,
  canManage,
}: {
  installation: Installation;
  canManage: boolean;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      {installation.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- GitHub avatars are external
        <img
          src={installation.avatarUrl}
          alt={installation.accountLogin}
          className="h-6 w-6 rounded-full"
        />
      ) : (
        <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted">
          <GithubIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {installation.accountLogin}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {installation.accountType} ·{" "}
          {installation.repositorySelection === "all"
            ? "all repositories"
            : "selected repositories"}
        </span>
      </div>
      {canManage && installation.htmlUrl && (
        <a
          href={installation.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-shrink-0 items-center gap-1 text-[11px] text-primary hover:underline"
          data-testid={`github-configure-${installation.id}`}
        >
          <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
          Configure
        </a>
      )}
    </li>
  );
}
