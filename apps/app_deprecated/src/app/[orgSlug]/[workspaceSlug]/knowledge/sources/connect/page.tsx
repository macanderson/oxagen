import type { Metadata } from "next";
// Importing the connectors barrel registers every built-in connector with the
// global registry (server-only; this is a Server Component) — same import
// marketplace/integrations/page.tsx and marketplace/integrations/[connectorId]/
// page.tsx rely on.
import { listConnectors } from "@oxagen/ingestion/connectors";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import type { ConnectorCatalogEntry } from "@/components/knowledge/connect/wizard-types";
import type { ConnectionMappingsGetOutput } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { ConnectSourceWizard } from "./connect-wizard";
import { getSourceMappingsAction } from "./actions";

export const metadata: Metadata = { title: "Connect a source — Knowledge" };

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// Connectors whose supported auth schemes are ENTIRELY OAuth2 flows can't be
// provisioned by this wizard's inline Credentials step — there is no
// oauth-start capability in this wizard's allowed set (see actions.ts header
// and connector-picker-step.tsx, which routes them to a real redirect-out
// instead of a dead stub).
const OAUTH_ONLY_SCHEMES = new Set([
  "oauth2_authorization_code",
  "oauth2_client_credentials",
]);

/**
 * Knowledge → Sources → Connect — the governed multi-step "Connect a source"
 * wizard (docs/web-app-2.0/workspace/knowledge/sources/connect/spec.md).
 *
 * Session + org/workspace + membership guard happens here (same
 * resolveOrg/assertOrgMember pattern as knowledge/ontology/page.tsx); the
 * connector catalog is read directly from the @oxagen/ingestion registry
 * (same source marketplace/integrations/page.tsx uses — not a capability
 * call, there is no connection.catalog/integration.list in this wizard's
 * allowed set). On resume (?connectionId=, e.g. after an external OAuth
 * redirect), mappings already saved for that connection are SSR-prefetched
 * via get_connection_mappings so the wizard can open straight at Step 4
 * instead of a client-side fetch waterfall.
 */
export default async function ConnectSourcePage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const sp = await searchParams;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  // Not bound to a variable — this wizard passes slugs (not ids) down to
  // ConnectSourceWizard, which round-trips them through ./actions.ts on every
  // capability call. The await is for resolveWorkspace's own notFound() guard
  // (a bad workspace slug 404s the page immediately) rather than its return value.
  await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const connectors: ConnectorCatalogEntry[] = listConnectors()
    // example-saas is a template/reference connector, not a real integration
    // (same exclusion marketplace/integrations/page.tsx applies).
    .filter((c) => c.connectorId !== "example-saas")
    .map((c) => ({
      connectorId: c.connectorId,
      displayName: c.displayName,
      description: c.description,
      icon: c.icon,
      isOAuthOnly:
        c.supportedAuthSchemes.length > 0 &&
        c.supportedAuthSchemes.every((s) => OAUTH_ONLY_SCHEMES.has(s)),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const initialConnectionId =
    typeof sp.connectionId === "string" ? sp.connectionId : undefined;

  let initialMappings: ConnectionMappingsGetOutput["mappings"] | undefined;
  if (initialConnectionId) {
    const result = await getSourceMappingsAction({
      orgSlug,
      workspaceSlug,
      connectionId: initialConnectionId,
    });
    if (result.ok) initialMappings = result.value.mappings;
  }

  return (
    <div className="flex flex-col gap-5 max-w-3xl px-6 py-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-foreground">
          Connect a source
        </p>
        <p className="text-xs text-muted-foreground">
          Pick a connector, provide credentials, preview sample records, and
          confirm entity mappings — agents gain cited, governed access to this
          data once it&apos;s connected.
        </p>
      </div>

      <ConnectSourceWizard
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        connectors={connectors}
        initialConnectionId={initialConnectionId}
        initialMappings={initialMappings}
      />
    </div>
  );
}
