/**
 * page.tsx — Workspace → Evals → Dataset detail (streaming RSC).
 *
 * Renders one dataset's items, a run-setup launcher (provider→model dropdowns for the
 * target + judge models), a server-driven sortable/paginated/date-filtered
 * table of every run ever executed against this dataset, and score/model
 * charts + gauges.
 *
 * Auth + org/workspace resolution happen immediately; the dataset + first
 * page of runs + score series are fetched behind a <Suspense> boundary
 * (mirrors runs/[runId]/page.tsx).
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/loading";
import { workspace } from "@/lib/routes";
import { DatasetDetailSection } from "./dataset-detail-section";

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    datasetId: string;
  }>;
}

export default async function EvalDatasetPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, datasetId } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  return (
    <div className="flex flex-col gap-5">
      <Link
        href={workspace.evals.root({ orgSlug, workspaceSlug })}
        className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to Evals
      </Link>

      <PageHeader
        title="Dataset"
        description="Items, run configuration, every run executed against this dataset, and score trends — all metered through @oxagen/ai."
      />

      <Suspense fallback={<TableSkeleton rows={6} cols={7} />}>
        <DatasetDetailSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          datasetPublicId={datasetId}
        />
      </Suspense>
    </div>
  );
}
