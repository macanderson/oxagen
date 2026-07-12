/**
 * repos-section.tsx — async server component that lists GitHub-typed
 * connections plus their repo.metrics, then hands off to ReposClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx so the static header
 * shows immediately while this component streams in. Never throws — a
 * failed list renders the client's own empty/unavailable state.
 */
import { listReposWithMetrics } from "@/lib/workbench/repos";
import type { WorkbenchCtx } from "@/lib/workbench/scope";
import { ReposClient } from "./repos-client";

interface ReposSectionProps {
  ctx: WorkbenchCtx;
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export async function ReposSection({ ctx, orgSlug, workspaceSlug, canManage }: ReposSectionProps) {
  let repos: Awaited<ReturnType<typeof listReposWithMetrics>> = [];
  let unavailable = false;
  try {
    repos = await listReposWithMetrics(ctx);
  } catch (e) {
    unavailable = true;
    console.error("list_connections (github) failed:", e);
  }

  return (
    <ReposClient
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
      initialRepos={repos}
      unavailable={unavailable}
    />
  );
}
