/**
 * page.tsx — Workspace → Knowledge → Sources (live data).
 *
 * RSC that fetches all source connections via the `connection.list` contract,
 * renders the connection list, and provides a "Connect source" button that
 * opens the GitHubConnectionWizard.
 */
import { notFound } from "next/navigation";
import { Database } from "lucide-react";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import { KnowledgeSourcesClient } from "@/components/knowledge/sources/knowledge-sources-client";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function KnowledgeSourcesPage({ params, searchParams }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const sp = await searchParams;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  if (!org) notFound();

  const ws = await resolveWorkspace(org.id, workspaceSlug);
  if (!ws) notFound();

  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let connections: ConnectionListOutput["connections"] = [];
  try {
    const result = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () => invoke("connection.list", {}, ctx, { surface: "agent" }),
    ) as ConnectionListOutput;
    connections = result.connections;
  } catch (e) {
    console.error("connection.list failed:", e);
    // Render empty state on failure — never throw from RSC page
  }

  // Parse wizard state from URL params (after OAuth callback)
  const setupConnector = typeof sp.setup === "string" ? sp.setup : undefined;
  const setupConnectionId = typeof sp.connectionId === "string" ? sp.connectionId : undefined;

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Database className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-foreground">Sources</p>
            <p className="text-xs text-muted-foreground">
              Authenticated data connections and ingest pipelines. Connect a source and your
              agents gain access to the data within their knowledge graph.
            </p>
          </div>
        </div>
        {/* "Connect source" button is client-side — delegates to KnowledgeSourcesClient */}
      </div>

      <KnowledgeSourcesClient
        connections={connections}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        setupConnector={setupConnector}
        setupConnectionId={setupConnectionId}
      />
    </div>
  );
}
