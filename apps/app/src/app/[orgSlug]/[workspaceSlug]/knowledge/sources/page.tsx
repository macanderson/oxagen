/**
 * page.tsx — Workspace → Knowledge → Sources (streaming RSC).
 *
 * Auth + org/workspace resolution happen immediately; the static header is
 * rendered at once. The data-dependent connection list is deferred behind a
 * <Suspense> boundary so the header is visible while the fetch streams in.
 */
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Database } from "lucide-react";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { TableSkeleton } from "@/components/loading";
import { ConnectionsSection } from "./connections-section";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KnowledgeReposPage({
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

  // Parse wizard state from URL params (after OAuth callback) — cheap, no I/O
  const setupConnector = typeof sp.setup === "string" ? sp.setup : undefined;
  const setupConnectionId =
    typeof sp.connectionId === "string" ? sp.connectionId : undefined;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Header — rendered immediately, before connection fetch */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Database
            className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div>
            <p className="text-sm font-semibold text-foreground">Repos</p>
            <p className="text-xs text-muted-foreground">
              Authenticated data connections and ingest pipelines. Connect a
              source and your agents gain access to the data within their
              knowledge graph.
            </p>
          </div>
        </div>
        {/* "Connect source" button is client-side — delegates to KnowledgeConnectionsClient */}
      </div>

      {/* Connection list streams in behind a Suspense boundary */}
      <Suspense fallback={<TableSkeleton rows={4} cols={3} />}>
        <ConnectionsSection
          orgId={org.id}
          workspaceId={ws.id}
          userId={session.user.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          setupConnector={setupConnector}
          setupConnectionId={setupConnectionId}
        />
      </Suspense>
    </div>
  );
}
