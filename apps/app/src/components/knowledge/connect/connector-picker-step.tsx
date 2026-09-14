"use client";

/**
 * connector-picker-step.tsx — Step 1 of the "Connect a source" wizard: pick a
 * connector from the installed/available catalog (see spec §Functionality
 * "Step 1 — Pick connector").
 *
 * OAuth-only connectors (every supported auth scheme is oauth2_*) cannot be
 * provisioned by this wizard's inline Credentials step — there is no
 * oauth-start capability in this wizard's allowed set (create_connection,
 * preview_connection, suggest/get/set_connection_mappings, get/validate
 * _plugin_schema, install/configure_integration — see actions.ts header).
 * Selecting one instead renders a real "redirect out" card: GitHub keeps its
 * bespoke Knowledge → Sources OAuth-App flow; every other OAuth-only
 * connector routes to the existing generic connector setup wizard at
 * Marketplace → Integrations → [connectorId] (apps/app/src/app/[orgSlug]/
 * [workspaceSlug]/marketplace/integrations/[connectorId]/), which already
 * installs it via install_integration. Both destinations redirect back to
 * Knowledge → Sources on success, not back to THIS wizard's `?connectionId=`
 * resume — closing that loop needs edits to pages outside this wizard's
 * boundary (Sources page / marketplace connectorId page), noted in the task
 * report as a follow-up.
 */

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Database, ExternalLink } from "lucide-react";
import { CapabilityIcon } from "@/components/plugins/capability-icon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import type { ConnectorCatalogEntry } from "./wizard-types";

export interface ConnectorPickerStepProps {
  orgSlug: string;
  workspaceSlug: string;
  connectors: ConnectorCatalogEntry[];
  onSelect: (connector: ConnectorCatalogEntry) => void;
}

export function ConnectorPickerStep({
  orgSlug,
  workspaceSlug,
  connectors,
  onSelect,
}: ConnectorPickerStepProps) {
  const [oauthNotice, setOauthNotice] =
    React.useState<ConnectorCatalogEntry | null>(null);

  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const sourcesHref = workspace.knowledge.sources(ctx);
  const integrationsHref = workspace.marketplace.integrations(ctx);

  if (connectors.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title="No connectors available"
        description="No connector plugins are registered for this workspace yet."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="grid gap-3 sm:grid-cols-2"
        data-testid="connector-picker-grid"
      >
        {connectors.map((connector) => {
          return (
            <div
              key={connector.connectorId}
              className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-4"
              data-testid={`connector-card-${connector.connectorId}`}
            >
              <div className="flex items-start gap-3">
                <CapabilityIcon
                  iconName={connector.icon}
                  color="var(--primary)"
                  size={28}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-foreground">
                    {connector.displayName}
                  </span>
                  {connector.isOAuthOnly && (
                    <Badge variant="outline" className="w-fit text-[10px]">
                      OAuth
                    </Badge>
                  )}
                </div>
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {connector.description}
              </p>

              {connector.isOAuthOnly ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setOauthNotice(connector)}
                  data-testid={`connector-select-${connector.connectorId}`}
                >
                  Connect via OAuth
                  <ExternalLink
                    className="ml-1.5 h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="w-full"
                  onClick={() => onSelect(connector)}
                  data-testid={`connector-select-${connector.connectorId}`}
                >
                  Select
                  <ArrowRight
                    className="ml-1.5 h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {oauthNotice && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
          data-testid="oauth-redirect-notice"
        >
          <p>
            <span className="font-medium text-foreground">
              {oauthNotice.displayName}
            </span>{" "}
            authenticates via OAuth, which this wizard doesn&apos;t drive inline
            yet. Continue in{" "}
            {oauthNotice.connectorId === "github"
              ? "Knowledge → Sources"
              : "Marketplace → Integrations"}{" "}
            to authorize it — the connection will show up back on the Sources
            list once it&apos;s connected.
          </p>
          <Link
            href={
              oauthNotice.connectorId === "github"
                ? `${sourcesHref}?setup=github`
                : `${integrationsHref}/${encodeURIComponent(oauthNotice.connectorId)}`
            }
            className="inline-flex w-fit items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:no-underline"
            data-testid="oauth-redirect-link"
          >
            Continue to {oauthNotice.displayName}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
  );
}
