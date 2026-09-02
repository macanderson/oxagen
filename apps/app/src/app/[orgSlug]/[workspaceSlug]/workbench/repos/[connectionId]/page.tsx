/**
 * page.tsx — Workspace → Workbench → Repos → [connectionId] (detail).
 *
 * `connectionId` is the GitHub connection's publicId (con_…), matching the
 * `repoId` the repo.metrics/sync/pause/resume/configure capabilities accept
 * (sourceConnectionRefCondition accepts either the publicId or the raw UUID,
 * but this UI only ever shows/passes the publicId — see lib/workbench/repos.ts).
 *
 * 404s when the id doesn't belong to this workspace — list_connections is
 * tenant-scoped, so an unresolved id is genuinely not here (mirrors
 * workbench/sandboxes/[sessionId]/page.tsx).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { logger } from "@oxagen/handlers/logger";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { workspace } from "@/lib/routes";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  listRepoConnections,
  getRepoMetrics,
  type RepoMetrics,
} from "@/lib/workbench/repos";
import { parseRepoSlug } from "@/lib/workbench/repo-slug";
import { RepoDetailClient, type TabValue } from "./repo-detail-client";

export const metadata: Metadata = {
  title: "Repo | Workbench",
};

const VALID_TABS: readonly TabValue[] = [
  "overview",
  "branches",
  "pulls",
  "files",
  "locks",
];

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    connectionId: string;
  }>;
  searchParams: Promise<{ tab?: string }>;
}

export default async function WorkbenchRepoDetailPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, workspaceSlug, connectionId } = await params;
  const { tab: requestedTab } = await searchParams;
  const initialTab: TabValue = (VALID_TABS as readonly string[]).includes(
    requestedTab ?? "",
  )
    ? (requestedTab as TabValue)
    : "overview";
  const { ctx, canManage } = await resolveWorkbenchScope(
    orgSlug,
    workspaceSlug,
  );

  const connections = await listRepoConnections(ctx);
  const connection = connections.find((c) => c.publicId === connectionId);
  if (!connection) {
    notFound();
  }

  let metrics: RepoMetrics | null = null;
  try {
    metrics = await getRepoMetrics(ctx, connectionId);
  } catch (err) {
    // Non-fatal: the Overview tab renders its own retry card from a null
    // metrics prop. Logged structurally (same logger the sibling actions use)
    // so the failure is correlatable instead of a bare stdout line.
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, connectionId },
      "workbench.repos: repo metrics lookup failed for the detail page",
    );
  }

  const slug = parseRepoSlug(connection.displayName);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={slug ? `${slug.owner}/${slug.repo}` : connection.displayName}
        description={
          slug
            ? "Branches, pull requests, CI, files, and file locks for this repo."
            : "This connection hasn't resolved a repo yet — finish setup in Knowledge → Sources."
        }
        className="pb-0"
        breadcrumb={
          <Breadcrumb
            items={[
              {
                label: "Repos",
                href: workspace.workbench.repos({ orgSlug, workspaceSlug }),
              },
              {
                label: slug
                  ? `${slug.owner}/${slug.repo}`
                  : connection.displayName,
              },
            ]}
          />
        }
      />
      <RepoDetailClient
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        connection={connection}
        slug={slug}
        initialMetrics={metrics}
        canManage={canManage}
        initialTab={initialTab}
      />
    </div>
  );
}
