/**
 * sources-section.tsx — Async server component that fetches connection data
 * and renders KnowledgeSourcesClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx so the static header
 * is shown immediately while this component streams in.
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import { KnowledgeSourcesClient } from "@/components/knowledge/sources/knowledge-sources-client";

interface SourcesSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
  setupConnector: string | undefined;
  setupConnectionId: string | undefined;
}

export async function SourcesSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
  setupConnector,
  setupConnectionId,
}: SourcesSectionProps) {
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
    <KnowledgeSourcesClient
      connections={connections}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      setupConnector={setupConnector}
      setupConnectionId={setupConnectionId}
    />
  );
}
