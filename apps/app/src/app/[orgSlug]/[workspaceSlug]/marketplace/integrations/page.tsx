import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
// Importing the connectors barrel registers every built-in connector with the
// global registry (server-only; this is a Server Component).
import { listConnectors } from "@oxagen/ingestion/connectors";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import { workspace } from "@/lib/routes";
import { docsUrl } from "@/lib/docs-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { CapabilityIcon } from "@/components/plugins/capability-icon";

export const metadata: Metadata = {
  title: "Integrations | Marketplace",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

// GitHub keeps its own bespoke GitHub-App OAuth installation flow under
// Knowledge → Repos (connection.create with a GitHub App installationId —
// see connection.create.ts's github authorization gate). Every other
// connector now gets the generic in-app setup wizard at
// marketplace/integrations/[connectorId] (ConnectorConfigForm, wired to
// install_integration / configure_integration / get_plugin_schema).
const GITHUB_APP_FLOW = new Set(["github"]);

const DELIVERY_LABELS: Record<string, string> = {
  webhook: "Webhook",
  poll: "Polling",
  rest_polling: "Polling",
  sql_query: "SQL",
  oauth: "OAuth",
};

/**
 * Marketplace → Integrations — the catalog of data connectors that ingest
 * external sources (GitHub, Slack, Google Workspace, Linear, Salesforce, …)
 * into the knowledge graph. Connecting hands off to the setup flow under
 * Knowledge → Repos; managing existing connections lives there too.
 */
export default async function MarketplaceIntegrationsPage({
  params,
}: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  await resolveWorkbenchScope(orgSlug, workspaceSlug);

  const ctx = { orgSlug, workspaceSlug };
  const connectors = listConnectors()
    // example-saas is a template/reference connector, not a real integration.
    .filter((c) => c.connectorId !== "example-saas")
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const reposHref = workspace.knowledge.sources(ctx);
  const integrationsHref = workspace.marketplace.integrations(ctx);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Connect external sources to ingest their data into the knowledge graph.
        Existing connections are managed under{" "}
        <Link
          href={reposHref}
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          Knowledge → Repos
        </Link>
        .
      </p>

      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        data-testid="integrations-grid"
      >
        {connectors.map((connector) => {
          const connectHref = GITHUB_APP_FLOW.has(connector.connectorId)
            ? `${reposHref}?setup=${encodeURIComponent(connector.connectorId)}`
            : `${integrationsHref}/${encodeURIComponent(connector.connectorId)}`;
          return (
            <Card key={connector.connectorId} className="flex flex-col">
              <CardHeader className="flex-1">
                <div className="flex items-start gap-3">
                  <CapabilityIcon
                    iconName={connector.icon}
                    color="var(--primary)"
                    size={32}
                  />
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="text-sm">
                      {connector.displayName}
                    </CardTitle>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline" className="text-[10px]">
                        {DELIVERY_LABELS[connector.deliveryMethod] ??
                          connector.deliveryMethod}
                      </Badge>
                    </div>
                  </div>
                </div>
                <CardDescription className="mt-2 line-clamp-3 text-xs">
                  {connector.description}
                </CardDescription>
              </CardHeader>
              <CardFooter className="flex flex-col gap-2">
                {/* Outline, not filled: a catalog of 9+ connectors would
                    otherwise be a wall of equal-weight primaries. Each card's
                    Connect is a peer action, so it reads as secondary. */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  render={
                    <Link
                      href={connectHref}
                      data-testid={`integration-connect-${connector.connectorId}`}
                    />
                  }
                >
                  Connect
                  <ArrowRight
                    className="ml-1.5 h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                </Button>
                <a
                  href={`${docsUrl()}/integrations/${encodeURIComponent(connector.connectorId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-center text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  data-testid={`integration-docs-${connector.connectorId}`}
                >
                  View setup docs
                </a>
              </CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
