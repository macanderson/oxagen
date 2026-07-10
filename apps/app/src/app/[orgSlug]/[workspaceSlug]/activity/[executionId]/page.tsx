/**
 * page.tsx — Workspace → Activity → one run's span-tree trace.
 *
 * Server component: resolves auth + scope, renders a back link + header, and
 * defers the live agent.trace.get fetch to <TraceSection> inside a Suspense
 * boundary.
 */
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { Skeleton } from "@/components/ui/skeleton";
import { workspace } from "@/lib/routes";
import { TraceSection } from "./trace-section";
import { LineageSection } from "./lineage-section";

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    executionId: string;
  }>;
}

export default async function TracePage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, executionId } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();
  await assertOrgMember(org.id, session.user.id);

  const backHref = workspace.activity.root({ orgSlug, workspaceSlug });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Link
          href={backHref}
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Activity
        </Link>
        <h1 className="font-mono text-lg font-semibold tracking-tight">{executionId}</h1>
      </div>
      <Suspense
        fallback={
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-11/12" />
            <Skeleton className="h-8 w-10/12" />
          </div>
        }
      >
        <TraceSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          executionId={executionId}
        />
      </Suspense>
      {/* File-level lineage graph — the :Execution and every :SourceFile it
          touched. Streams in its own Suspense boundary and renders nothing when
          the run recorded no TOUCHED_FILE edges. */}
      <Suspense fallback={null}>
        <LineageSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          executionId={executionId}
        />
      </Suspense>
    </div>
  );
}
