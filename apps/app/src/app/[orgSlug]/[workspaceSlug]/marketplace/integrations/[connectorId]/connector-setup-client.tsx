"use client";

/**
 * connector-setup-client.tsx — mounts the shared connector setup wizard
 * (ConnectorSchemaProvider + ConnectorConfigForm) for the Marketplace →
 * Integrations → [connectorId] route.
 *
 * On success: the install_integration call returns a `pending_setup`
 * ingestion.source_connections row (see integration.install.ts handler) —
 * the same row shape connection.create produces. Authentication (OAuth
 * handshake / secret entry beyond what the schema form collects) and the
 * first sync are subsequent steps managed from Knowledge → Repos, so a
 * successful install redirects there rather than pretending the connector is
 * fully live.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConnectorSchemaProvider } from "@/components/connectors/connector-schema-provider";
import { ConnectorConfigForm } from "@/components/connectors/connector-config-form";
import { useToast } from "@/components/ui/toast";
import { workspace } from "@/lib/routes";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";

export interface ConnectorSetupClientProps {
  orgSlug: string;
  workspaceSlug: string;
  connectorId: string;
  connectorDisplayName: string;
  initialSchema?: ConnectorPluginSchema;
}

export function ConnectorSetupClient({
  orgSlug,
  workspaceSlug,
  connectorId,
  connectorDisplayName,
  initialSchema,
}: ConnectorSetupClientProps) {
  const router = useRouter();
  const { add: addToast } = useToast();

  const ctx = React.useMemo(
    () => ({ orgSlug, workspaceSlug }),
    [orgSlug, workspaceSlug],
  );
  const reposHref = workspace.knowledge.repos(ctx);
  const integrationsHref = workspace.marketplace.integrations(ctx);

  const handleSuccess = React.useCallback(() => {
    addToast({
      title: `${connectorDisplayName} connected`,
      description:
        "Finish authentication and manage the connection from Knowledge → Repos.",
      type: "success",
    });
    router.push(reposHref);
  }, [addToast, connectorDisplayName, reposHref, router]);

  const handleCancel = React.useCallback(() => {
    router.push(integrationsHref);
  }, [integrationsHref, router]);

  return (
    <ConnectorSchemaProvider
      pluginId={connectorId}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      initialSchema={initialSchema}
    >
      <ConnectorConfigForm
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        mode="install"
        displayName={connectorDisplayName}
        onSuccess={handleSuccess}
        onCancel={handleCancel}
      />
    </ConnectorSchemaProvider>
  );
}
