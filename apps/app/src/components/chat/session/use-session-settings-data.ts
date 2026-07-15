"use client";
/**
 * use-session-settings-data.ts — the branch-list fetch shared by every
 * `SessionSettings` host (mobile drawer, desktop rail panel, mid-width
 * slide-over). Resolves the session's selected repo, lazily fetches and
 * caches its branch list via `listRepoBranchesAction`, and hands back exactly
 * the `branches`/`branchesLoading`/`onLoadBranches`/`defaultBranch` shape
 * `SessionSettings` expects — one implementation instead of three copies of
 * the same cache-plus-in-flight-guard logic.
 */
import * as React from "react";
import { useChatSession } from "./session-store";
import { listRepoBranchesAction } from "./branch-actions";
import type { RepoOption } from "../repo-selector";

export interface SessionSettingsData {
  selectedRepo: RepoOption | null;
  branches: string[] | null;
  branchesLoading: boolean;
  defaultBranch: string | null;
  onLoadBranches: () => void;
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

  const [branchCache, setBranchCache] = React.useState<
    Record<string, { branches: string[]; defaultBranch: string | null }>
  >({});
  const [branchesLoading, setBranchesLoading] = React.useState(false);
  const loadingRepoKeyRef = React.useRef<string | null>(null);

  const onLoadBranches = React.useCallback(() => {
    if (!selectedRepo) return;
    if (branchCache[selectedRepo.key]) return; // cached — no refetch
    if (loadingRepoKeyRef.current === selectedRepo.key) return; // in flight
    loadingRepoKeyRef.current = selectedRepo.key;
    setBranchesLoading(true);
    void listRepoBranchesAction(
      { orgSlug, workspaceSlug },
      { owner: selectedRepo.owner, repo: selectedRepo.name },
    )
      .then((result) => {
        if ("error" in result) return;
        setBranchCache((prev) => ({
          ...prev,
          [selectedRepo.key]: {
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
  }, [selectedRepo, orgSlug, workspaceSlug]);

  const cached = selectedRepo ? branchCache[selectedRepo.key] : undefined;
  const branches = cached ? cached.branches : null;
  const defaultBranch =
    cached?.defaultBranch ?? selectedRepo?.defaultBranch ?? null;

  return { selectedRepo, branches, branchesLoading, defaultBranch, onLoadBranches };
}
