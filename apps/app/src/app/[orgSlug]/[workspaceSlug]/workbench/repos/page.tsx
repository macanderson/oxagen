/**
 * page.tsx — Workspace → Workbench → Repos.
 *
 * The GitHub-typed connections ("repos") home: sync/pause/resume control, an
 * "Edit file & open PR" agent launcher, and Create/Fork/Connect GitHub App
 * header actions. Data loads server-side via resolveWorkbenchScope +
 * listReposWithMetrics inside <Suspense> (repos-section.tsx) so the header
 * renders immediately.
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/loading";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { ReposSection } from "./repos-section";

export const metadata: Metadata = {
  title: "Repos | Workbench",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function WorkbenchReposPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { ctx, canManage } = await resolveWorkbenchScope(orgSlug, workspaceSlug);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Repos"
        description="GitHub repositories connected to this workspace — sync, pause/resume, and dispatch a code agent to edit a file and open a PR."
        className="pb-0"
      />
      <Suspense fallback={<TableSkeleton rows={6} cols={5} />}>
        <ReposSection ctx={ctx} orgSlug={orgSlug} workspaceSlug={workspaceSlug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
