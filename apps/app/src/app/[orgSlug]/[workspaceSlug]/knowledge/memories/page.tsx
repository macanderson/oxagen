/**
 * page.tsx — Workspace → Knowledge → Memories.
 *
 * Server component that resolves auth + org/workspace scope, fetches initial
 * AgentMemory records from Neo4j, and renders MemoriesClient with full
 * filtering and inspection capabilities.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { TableSkeleton } from "@/components/loading";
import { MemoriesSection } from "./memories-section";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function KnowledgeMemoriesPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  return (
    <div className="flex flex-col gap-5">
      <Suspense fallback={<TableSkeleton rows={8} cols={4} />}>
        <MemoriesSection
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
