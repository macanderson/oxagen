/**
 * page.tsx — Workspace → Evals (streaming RSC).
 *
 * The eval.* capability family closes the loop between "what an agent said"
 * and "what we can prove it's worth billing for": a dataset of real inputs
 * (hand-authored or pulled from traces) is run against a target (model or
 * agent) and scored by an LLM judge, with every target/judge call flowing
 * through @oxagen/ai so tokens, latency, and cost land in the metering pipe.
 * This page is the entry point — the dataset list. Auth + org/workspace
 * resolution happen immediately; the dataset fetch is deferred behind a
 * <Suspense> boundary so the header renders before the fetch resolves.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { PageHeader } from "@/components/ui/page-header";
import { TableSkeleton } from "@/components/loading";
import { DatasetsSection } from "./datasets-section";
import { RecentRunsSection } from "./recent-runs-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function EvalsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Evals"
        description="Datasets of real inputs — hand-authored or pulled from traces — run against a model or agent and graded by an LLM judge, every call metered so eval cost is visible cost."
      />

      <Suspense fallback={<TableSkeleton rows={4} cols={5} />}>
        <DatasetsSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </Suspense>

      <Suspense fallback={<TableSkeleton rows={4} cols={8} />}>
        <RecentRunsSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </Suspense>
    </div>
  );
}
