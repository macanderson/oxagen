"use client";
/**
 * use-session-settings-data.ts — the branch-list fetch shared by every surface
 * that lets a user choose a branch: the `SessionSettings` hosts (mobile drawer,
 * desktop rail panel, mid-width slide-over) and the agent picker's code-agent
 * setup step.
 *
 * Two layers, because the hosts differ in where the repo comes from:
 *
 *   - `useRepoBranches` takes a repo DIRECTLY. It owns the cache, the in-flight
 *     guard, and the `listRepoBranchesAction` call. The agent picker's setup
 *     step uses this one: its repo is a local pending choice, and the panel can
 *     render outside a `ChatSessionProvider`, so it cannot read the store.
 *   - `useSessionSettingsData` resolves the repo from the session store and
 *     delegates to `useRepoBranches`, handing back exactly the
 *     `branches`/`branchesLoading`/`onLoadBranches`/`defaultBranch` shape
 *     `SessionSettings` expects.
 *
 * One implementation of the cache-plus-in-flight-guard logic, not several
 * copies.
 */
import * as React from "react";
import { useChatSession } from "./session-store";
import { listRepoBranchesAction } from "./branch-actions";
import type { RepoOption } from "../repo-selector";

export interface RepoBranchesData {
  branches: string[] | null;
  branchesLoading: boolean;
  defaultBranch: string | null;
  onLoadBranches: () => void;
}

export interface SessionSettingsData extends RepoBranchesData {
  selectedRepo: RepoOption | null;
}

/**
 * Lazily fetch (and cache) the branch list for `repo`. Inert — `onLoadBranches`
 * is a no-op and `branches` stays null — when there is no repo or no org/
 * workspace scope to fetch under, so a caller that lacks slugs degrades to "no
 * branch list" instead of throwing.
 */
export function useRepoBranches({
  repo,
  orgSlug,
  workspaceSlug,
}: {
  repo: RepoOption | null;
  orgSlug: string | undefined;
  workspaceSlug: string | undefined;
}): RepoBranchesData {
  const [branchCache, setBranchCache] = React.useState<
    Record<string, { branches: string[]; defaultBranch: string | null }>
  >({});
  const [branchesLoading, setBranchesLoading] = React.useState(false);
  const loadingRepoKeyRef = React.useRef<string | null>(null);

  const onLoadBranches = React.useCallback(() => {
    if (!repo || !orgSlug || !workspaceSlug) return;
    if (branchCache[repo.key]) return; // cached — no refetch
    if (loadingRepoKeyRef.current === repo.key) return; // in flight
    loadingRepoKeyRef.current = repo.key;
    setBranchesLoading(true);
    void listRepoBranchesAction(
      { orgSlug, workspaceSlug },
      { owner: repo.owner, repo: repo.name },
    )
      .then((result) => {
        if ("error" in result) {
          // The picker has nowhere to put this yet, so it renders as "No
          // branches found" — indistinguishable from a repo with no branches.
          // Log it so the difference is at least visible in a support session.
          console.error("session-settings: branch list failed", result.error);
          return;
        }
        setBranchCache((prev) => ({
          ...prev,
          [repo.key]: {
            branches: result.branches.map((b) => b.name),
            defaultBranch: result.defaultBranch,
          },
        }));
      })
      .catch(() => {
        // Swallow: a rejected server-action promise (transient network error,
        // or a throw from scope resolution that runs outside the action's
        // try/catch) still needs to release the in-flight guard below so the
        // loader can retry instead of wedging in a permanent loading state.
      })
      .finally(() => {
        loadingRepoKeyRef.current = null;
        setBranchesLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- branchCache is read for its CURRENT snapshot to skip a refetch; including it would re-create this callback (and re-arm the in-flight guard) on every cache write
  }, [repo, orgSlug, workspaceSlug]);

  const cached = repo ? branchCache[repo.key] : undefined;
  const branches = cached ? cached.branches : null;
  const defaultBranch = cached?.defaultBranch ?? repo?.defaultBranch ?? null;

  return { branches, branchesLoading, defaultBranch, onLoadBranches };
}

export function useSessionSettingsData({
  repos,
  orgSlug,
  workspaceSlug,
}: {
  repos: RepoOption[];
  orgSlug: string;
  workspaceSlug: string;
}): SessionSettingsData {
  const { state } = useChatSession();
  const selectedRepo = state.repoKey
    ? (repos.find((r) => r.key === state.repoKey) ?? null)
    : null;

  const branchData = useRepoBranches({
    repo: selectedRepo,
    orgSlug,
    workspaceSlug,
  });

  return { selectedRepo, ...branchData };
}
