/**
 * page.tsx — Workspace → Knowledge → Memories (live Engram data).
 *
 * Server component that resolves auth + org/workspace scope, fetches initial
 * memory records from the Engram store, and renders the MemoriesClient with
 * full filtering and inspection capabilities.
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KnowledgeMemoriesPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const sp = await searchParams;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  // Parse filter state from URL search params
  const kindFilter = typeof sp.kind === "string" ? sp.kind : undefined;
  const minSalience =
    typeof sp.salience === "string" ? Number(sp.salience) : undefined;

  return (
    <div className="flex flex-col gap-5">
      <Suspense fallback={<TableSkeleton rows={8} cols={4} />}>
        <MemoriesSection
          orgId={org.id}
          workspaceId={ws.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          kindFilter={kindFilter}
          minSalience={minSalience}
        />
      </Suspense>
    </div>
  );
}
