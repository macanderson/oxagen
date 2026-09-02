/**
 * page.tsx — Workspace → Evals → Run detail (streaming RSC).
 *
 * Renders one eval.run.get result: the run summary (status, avg score, pass
 * rate, judge model, target) and the per-item judge results (score,
 * correctness, faithfulness, pass/fail, latency, tokens, cost). Auth +
 * org/workspace resolution happen immediately; the run fetch is deferred
 * behind a <Suspense> boundary.
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
import { RunDetailSection } from "./run-detail-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; runId: string }>;
}

export default async function EvalRunPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, runId } = await params;
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
        title="Eval run"
        description="Per-item judge results for this run — every target and judge call was metered through @oxagen/ai."
      />

      <Suspense fallback={<TableSkeleton rows={6} cols={7} />}>
        <RunDetailSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          runPublicId={runId}
        />
      </Suspense>
    </div>
  );
}
