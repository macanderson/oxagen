"use client";

/**
 * github-connection-wizard-step2.tsx — Step 2 "Select Repos": cascading
 * org → repo selector rendered after OAuth returns.
 *
 * The installed-orgs list is not fixed: a user can add the Oxagen GitHub App to
 * another org (or remove one, or change which repos an org grants) via GitHub's
 * install/configure page. We surface that as a "Manage GitHub App access" link
 * that opens GitHub in a new tab; when the user returns (window regains focus)
 * we re-fetch installations so newly-installed orgs become selectable. A manual
 * "Refresh" button covers the case where focus detection misses.
 */

import * as React from "react";
import { GithubIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { DialogFooter } from "@oxagen/ui";
import {
  type Installation,
  type InstallationsResponse,
  type Repository,
  API_BASE,
} from "./github-connection-wizard-types";
import { Spinner } from "./github-connection-wizard-spinner";

/** Subset of Repository fields passed to the next step so Step3 can send
 *  owner/repo/defaultBranch in the PUT body without a second fetch. */
export interface SelectedRepoMeta {
  fullName: string;
  defaultBranch: string;
}

export interface Step2Props {
  orgSlug: string;
  workspaceSlug: string;
  connectionId: string;
  onNext: (selectedInstallationId: string, repos: SelectedRepoMeta[]) => void;
}

export function Step2SelectRepos({
  orgSlug,
  workspaceSlug,
  connectionId,
  onNext,
}: Step2Props) {
  const [installations, setInstallations] = React.useState<Installation[]>([]);
  const [manageUrl, setManageUrl] = React.useState<string | null>(null);
  const [installationsLoading, setInstallationsLoading] = React.useState(true);
  const [installationsRefreshing, setInstallationsRefreshing] =
    React.useState(false);
  const [installationsError, setInstallationsError] = React.useState<
    string | null
  >(null);

  const [selectedInstallationId, setSelectedInstallationId] = React.useState<
    number | null
  >(null);

  const [repositories, setRepositories] = React.useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = React.useState(false);
  const [reposError, setReposError] = React.useState<string | null>(null);
  const [reposReloadNonce, setReposReloadNonce] = React.useState(0);

  const [selectedRepos, setSelectedRepos] = React.useState<Set<string>>(
    new Set(),
  );

  // Armed when the user opens GitHub's manage page; the next time the window
  // regains focus we re-fetch so any orgs/repos they just (un)installed appear.
  const awaitingRefreshRef = React.useRef(false);

  // Load installations. `mode: "refresh"` keeps the current list visible and
  // preserves the selected org if it still exists (used by the manual Refresh
  // button and the on-focus re-fetch); "initial" shows the full-panel spinner.
  const loadInstallations = React.useCallback(
    async (mode: "initial" | "refresh") => {
      if (mode === "initial") {
        setInstallationsLoading(true);
      } else {
        setInstallationsRefreshing(true);
      }
      setInstallationsError(null);

      try {
        const res = await fetch(
          `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/installations?connectionId=${connectionId}`,
          { credentials: "include" },
        );
        if (!res.ok)
          throw new Error(`Failed to load organizations: ${res.status}`);
        const data = (await res.json()) as InstallationsResponse;
        setInstallations(data.installations);
        setManageUrl(data.manageUrl);
        // Drop the selection only if the org it pointed at is gone (e.g. removed
        // on GitHub); otherwise keep it so the repo list stays put.
        setSelectedInstallationId((prev) =>
          prev !== null && data.installations.some((i) => i.id === prev)
            ? prev
            : null,
        );
      } catch (e) {
        setInstallationsError(
          e instanceof Error ? e.message : "Failed to load organizations",
        );
      } finally {
        setInstallationsLoading(false);
        setInstallationsRefreshing(false);
      }
    },
    [orgSlug, workspaceSlug, connectionId],
  );

  // Fetch installations on mount.
  React.useEffect(() => {
    void loadInstallations("initial");
  }, [loadInstallations]);

  // When the user returns from GitHub's manage page, re-fetch installations and
  // (if an org is selected) its repos so newly granted access shows up.
  React.useEffect(() => {
    const handleReturn = () => {
      if (document.visibilityState !== "visible") return;
      if (!awaitingRefreshRef.current) return;
      awaitingRefreshRef.current = false;
      void loadInstallations("refresh");
      setReposReloadNonce((n) => n + 1);
    };
    window.addEventListener("focus", handleReturn);
    document.addEventListener("visibilitychange", handleReturn);
    return () => {
      window.removeEventListener("focus", handleReturn);
      document.removeEventListener("visibilitychange", handleReturn);
    };
  }, [loadInstallations]);

  // Fetch repositories when an installation is selected (or a reload is forced).
  React.useEffect(() => {
    if (selectedInstallationId === null) {
      setRepositories([]);
      return;
    }

    let cancelled = false;
    setReposLoading(true);
    setReposError(null);
    setSelectedRepos(new Set());

    fetch(
      `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/installations/${selectedInstallationId}/repositories?connectionId=${connectionId}`,
      { credentials: "include" },
    )
      .then(async (res) => {
        if (!res.ok)
          throw new Error(`Failed to load repositories: ${res.status}`);
        return res.json() as Promise<{
          repositories: Repository[];
          totalCount: number;
        }>;
      })
      .then((data) => {
        if (!cancelled) {
          setRepositories(data.repositories);
          setReposLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setReposError(
            e instanceof Error ? e.message : "Failed to load repositories",
          );
          setReposLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    orgSlug,
    workspaceSlug,
    connectionId,
    selectedInstallationId,
    reposReloadNonce,
  ]);

  const allSelected =
    repositories.length > 0 &&
    repositories.every((r) => selectedRepos.has(r.fullName));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedRepos(new Set());
    } else {
      setSelectedRepos(new Set(repositories.map((r) => r.fullName)));
    }
  };

  const toggleRepo = (fullName: string) => {
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) {
        next.delete(fullName);
      } else {
        next.add(fullName);
      }
      return next;
    });
  };

  const selectedInstallation = installations.find(
    (i) => i.id === selectedInstallationId,
  );

  // Arm the on-focus re-fetch and open GitHub's manage page in a new tab.
  const openManagePage = (url: string) => {
    awaitingRefreshRef.current = true;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const handleNext = () => {
    if (selectedInstallationId === null || selectedRepos.size === 0) return;
    // Include the full repo object so Step3 can forward defaultBranch to the
    // API without a second round-trip. We already have the Repository list.
    const repoMetas: SelectedRepoMeta[] = repositories
      .filter((r) => selectedRepos.has(r.fullName))
      .map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch }));
    onNext(String(selectedInstallationId), repoMetas);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Org list */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-muted-foreground">
            Select organization
          </p>
          {!installationsLoading && (
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              onClick={() => void loadInstallations("refresh")}
              disabled={installationsRefreshing}
              data-testid="refresh-installations-btn"
            >
              <RefreshCwIcon
                className={`h-3 w-3 ${installationsRefreshing ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              Refresh
            </button>
          )}
        </div>
        {installationsLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        ) : installationsError ? (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {installationsError}
          </p>
        ) : installations.length === 0 ? (
          <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
            No GitHub App installations found. Install the GitHub App on your
            account or organization using the link below, then refresh.
          </p>
        ) : (
          <ul
            className="max-h-36 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/40"
            data-testid="installation-list"
          >
            {installations.map((installation) => (
              <li key={installation.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50 ${
                    selectedInstallationId === installation.id
                      ? "bg-primary/10 text-primary"
                      : "text-foreground"
                  }`}
                  onClick={() => setSelectedInstallationId(installation.id)}
                  data-testid={`installation-item-${installation.id}`}
                  data-selected={
                    selectedInstallationId === installation.id ? "" : undefined
                  }
                >
                  {installation.avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- GitHub avatars are external
                    <img
                      src={installation.avatarUrl}
                      alt={installation.accountLogin}
                      className="h-5 w-5 rounded-full"
                    />
                  ) : (
                    <div className="flex h-5 w-5 items-center justify-center rounded-full bg-muted">
                      <GithubIcon className="h-3 w-3" aria-hidden="true" />
                    </div>
                  )}
                  <span className="flex-1 truncate font-medium">
                    {installation.accountLogin}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {installation.accountType}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Manage installation access — add the App to another org or change repos. */}
        {manageUrl && !installationsLoading && (
          <button
            type="button"
            className="flex items-center gap-1 self-start text-[11px] text-primary hover:underline"
            onClick={() => openManagePage(manageUrl)}
            data-testid="manage-installations-link"
          >
            <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
            {installations.length === 0
              ? "Install the GitHub App on an organization"
              : "Don't see an organization? Manage GitHub App access"}
          </button>
        )}
      </div>

      {/* Repo list */}
      {selectedInstallationId !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground">
              Select repositories
              {selectedInstallation?.repositorySelection === "all" && (
                <span className="ml-1 text-[11px] text-info">
                  (all repositories granted)
                </span>
              )}
            </p>
            {repositories.length > 0 && (
              <button
                type="button"
                className="text-[11px] text-primary hover:underline"
                onClick={toggleAll}
                data-testid="select-all-repos-btn"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            )}
          </div>

          {reposLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner />
            </div>
          ) : reposError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {reposError}
            </p>
          ) : repositories.length === 0 ? (
            <p className="rounded-md border border-border/60 px-3 py-2 text-xs text-muted-foreground">
              No repositories found for this installation.
            </p>
          ) : (
            <ul
              className="max-h-48 overflow-y-auto rounded-lg border border-border/60 divide-y divide-border/40"
              data-testid="repository-list"
            >
              {repositories.map((repo) => {
                const isChecked = selectedRepos.has(repo.fullName);
                return (
                  <li key={repo.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-muted/50 transition-colors">
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleRepo(repo.fullName)}
                        data-testid={`repo-checkbox-${repo.name}`}
                      />
                      <div className="flex flex-1 items-center gap-2 min-w-0">
                        <span className="flex-1 truncate text-sm font-medium text-foreground">
                          {repo.name}
                        </span>
                        <span
                          className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            repo.private
                              ? "bg-warning/12 text-warning"
                              : "bg-success/12 text-success"
                          }`}
                        >
                          {repo.private ? "Private" : "Public"}
                        </span>
                        {repo.language && (
                          <span className="flex-shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {repo.language}
                          </span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          {/* Repos missing? Adjust which repos this org grants on GitHub. */}
          {selectedInstallation?.htmlUrl && (
            <button
              type="button"
              className="flex items-center gap-1 self-start text-[11px] text-primary hover:underline"
              onClick={() => openManagePage(selectedInstallation.htmlUrl!)}
              data-testid="configure-repos-link"
            >
              <ExternalLinkIcon className="h-3 w-3" aria-hidden="true" />
              Configure repositories on GitHub
            </button>
          )}
        </div>
      )}

      <DialogFooter className="mt-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          disabled={selectedInstallationId === null || selectedRepos.size === 0}
          onClick={handleNext}
          data-testid="select-repos-next-btn"
        >
          Continue
        </button>
      </DialogFooter>
    </div>
  );
}
