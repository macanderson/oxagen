import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
// Importing the connectors barrel registers every built-in connector with the
// global registry (server-only; this is a Server Component) — same import
// marketplace/integrations/page.tsx relies on.
import { getConnector } from "@oxagen/ingestion/connectors";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import { CapabilityIcon } from "@/components/plugins/capability-icon";
import { ConnectorSetupClient } from "./connector-setup-client";
import { getConnectorSetupSchemaAction } from "./actions";

interface PageProps {
  params: Promise<{
    orgSlug: string;
    workspaceSlug: string;
    connectorId: string;
  }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { connectorId } = await params;
  try {
    const connector = getConnector(connectorId);
    return { title: `Connect ${connector.displayName} | Marketplace` };
  } catch {
    return { title: "Connect | Marketplace" };
  }
}

/**
 * Marketplace → Integrations → [connectorId] — the in-app setup wizard for a
 * single connector. Mounts the shared ConnectorConfigForm cluster
 * (apps/app/src/components/connectors/) against the real install_integration
 * / configure_integration / get_plugin_schema contracts.
 *
 * GitHub is NOT routed here — it keeps its bespoke GitHub-App OAuth
 * installation flow under Knowledge → Repos (see
 * marketplace/integrations/page.tsx's GITHUB_APP_FLOW set). Every other
 * connector in the @oxagen/ingestion registry gets this generic wizard.
 */
export default async function ConnectorSetupPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, connectorId } = await params;

  // Session + org/workspace + membership guard (redirects/404s as needed).
  await resolveWorkbenchScope(orgSlug, workspaceSlug);

  let connector: ReturnType<typeof getConnector>;
  try {
    connector = getConnector(connectorId);
  } catch {
    notFound();
  }

  const ctx = { orgSlug, workspaceSlug };
  const integrationsHref = workspace.marketplace.integrations(ctx);

  const schemaResult = await getConnectorSetupSchemaAction({
    orgSlug,
    workspaceSlug,
    connectorId,
  });

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <div className="flex flex-col gap-3">
        <Link
          href={integrationsHref}
          className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Back to Integrations
        </Link>

        <div className="flex items-start gap-3">
          <CapabilityIcon
            iconName={connector.icon}
            color="var(--primary)"
            size={32}
          />
          <div>
            <p className="text-sm font-semibold text-foreground">
              Connect {connector.displayName}
            </p>
            <p className="text-xs text-muted-foreground">
              {connector.description}
            </p>
          </div>
        </div>
      </div>

      <ConnectorSetupClient
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        connectorId={connectorId}
        connectorDisplayName={connector.displayName}
        initialSchema={schemaResult.ok ? schemaResult.schema : undefined}
      />

      {!schemaResult.ok && (
        <p className="text-xs text-muted-foreground" role="status">
          Couldn&apos;t preload this connector&apos;s configuration (
          {schemaResult.error}) — retrying in the browser.
        </p>
      )}
    </div>
  );
}
