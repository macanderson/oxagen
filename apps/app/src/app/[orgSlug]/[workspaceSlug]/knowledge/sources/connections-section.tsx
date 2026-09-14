/**
 * connections-section.tsx — Async server component that fetches connection data
 * and renders KnowledgeConnectionsClient.
 *
 * Rendered inside a <Suspense> boundary in page.tsx so the static header
 * is shown immediately while this component streams in.
 */
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "@oxagen/handlers/logger";
import type { ConnectionListOutput } from "@oxagen/oxagen/contracts/connection.list";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
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
  let loadFailed = false;
  try {
    const result = (await runInTenantScope({ orgId, workspaceId }, () =>
      invoke("list_connections", {}, ctx, { surface: "agent" }),
    )) as ConnectionListOutput;
    connections = result.connections;
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId },
      "knowledge.sources: list_connections failed",
    );
    // A fetch failure is distinct from "no sources yet" — surface it as an
    // error (never throw from RSC, which would blank the streamed header)
    // rather than masquerading the failure as the client's empty state.
    loadFailed = true;
  }

  if (loadFailed) {
    return (
      <ErrorState
        title="Couldn't load sources"
        description="Something went wrong loading your connected sources. Reload the page to try again."
      />
    );
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
