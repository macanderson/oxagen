/**
 * sources-section.tsx — Async server component that fetches connection data
 * and renders KnowledgeConnectionsClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx so the static header
 * is shown immediately while this component streams in.
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import { KnowledgeConnectionsClient } from "@/components/knowledge/connections/knowledge-connections-client";

interface ConnectionsSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  setupConnector: string | undefined;
  setupConnectionId: string | undefined;
}

export async function ConnectionsSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  setupConnector,
  setupConnectionId,
}: ConnectionsSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  let connections: ConnectionListOutput["connections"] = [];
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke("connection.list", {}, ctx, { surface: "agent" }),
    )) as ConnectionListOutput;
    connections = result.connections;
  } catch (e) {
    console.error("connection.list failed:", e);
    // Render empty state on failure — never throw from RSC
  }

  return (
    <KnowledgeConnectionsClient
      connections={connections}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      setupConnector={setupConnector}
      setupConnectionId={setupConnectionId}
    />
  );
}
