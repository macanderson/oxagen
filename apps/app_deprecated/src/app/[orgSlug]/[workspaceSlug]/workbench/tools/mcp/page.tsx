import type { Metadata } from "next";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ExternalLink, KeySquare } from "lucide-react";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import "@oxagen/handlers/register";
import { Suspense } from "react";
import { listWorkspaceCredentialStatuses } from "@oxagen/plugins";
import { logger } from "@oxagen/handlers/logger";
import { resolveWorkbenchScope } from "@/lib/workbench/scope";
import {
  installPlugin,
  togglePlugin,
  uninstallPlugin,
} from "@/lib/agent-tools/install-actions";
import {
  connectCustomMcpServer,
  revokeMcpCredential,
  setMcpServerSecret,
} from "./mcp-actions";
import { workspace } from "@/lib/routes";
import { ConnectMcpForm } from "./connect-mcp-form";
import { McpCatalogSearch } from "./mcp-catalog-search";
import { McpOauthResultToast } from "./mcp-oauth-result-toast";
import { McpServerList, type McpServerRow } from "./mcp-server-list";
// McpInstallTabs is the presentational client component that renders the
// per-client copy-paste install snippets — reused verbatim from
// Developer → MCP (apps/app/src/app/[orgSlug]/developer/mcp/) rather than
// re-implemented, since it's a pure props-in component with no org-page
// server logic baked in.
import {
  McpInstallTabs,
  type McpTabEntry,
} from "../../../../developer/mcp/mcp-install-tabs";

export const metadata: Metadata = {
  title: "MCP Servers | Agent Tools",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  // ?reauth=<orgListingId> — set by the "needs re-auth" notification deep link
  // (packages/plugins/src/oauth/mark-reauth.ts). Highlights + scrolls to the
  // server whose credential expired so the user lands directly on its
  // Re-authenticate action.
  searchParams: Promise<{ reauth?: string }>;
}

const MCP_URL = "https://mcp.oxagen.sh/mcp";
// Sentinel workspaceId for org-only reads (API keys are org-scoped) — mirrors
// developer/mcp/page.tsx's ORG_ONLY_WS.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/** Build the install snippets with a real (or placeholder) API key. */
function buildSnippets(
  apiKey: string,
): Array<Omit<McpTabEntry, "highlightedHtml">> {
  return [
    {
      key: "claude_code",
      client: "Claude Code",
      raw: `claude mcp add oxagen \\\n  --transport http \\\n  --url ${MCP_URL} \\\n  --header "Authorization: Bearer ${apiKey}"`,
    },
    {
      key: "claude_desktop",
      client: "Claude Desktop",
      raw: `{
  "mcpServers": {
    "oxagen": {
      "command": "npx",
      "args": ["-y", "@oxagen/mcp-client"],
      "env": {
        "OXAGEN_API_KEY": "${apiKey}"
      }
    }
  }
}`,
    },
    {
      key: "cursor",
      client: "Cursor",
      raw: `{
  "mcp": {
    "servers": [
      {
        "name": "oxagen",
        "transport": "http",
        "url": "${MCP_URL}",
        "headers": {
          "Authorization": "Bearer ${apiKey}"
        }
      }
    ]
  }
}`,
    },
  ];
}

/** Shiki is an optional enhancement — fall back to plain text on failure. */
async function highlight(code: string, lang: string): Promise<string> {
  try {
    const { codeToHtml } = await import("shiki");
    return await codeToHtml(code, { lang, theme: "one-dark-pro" });
  } catch {
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre><code>${escaped}</code></pre>`;
  }
}

/**
 * Workbench → Agent Tools → MCP Servers — manage the servers this workspace
 * has installed.
 *
 * (a) Installed mcp_server plugins, first: credential status per server with
 *     Authenticate / Re-authenticate (OAuth authorize route) and Remove auth
 *     (revoke_plugin_credential), plus the same toggle/uninstall actions as
 *     the Capabilities tab.
 * (b) Install NEW servers: from the marketplace catalog (McpCatalogSearch →
 *     plugin.catalog.browse) or manually by endpoint (plugin.org.install,
 *     custom endpoint) — see @/lib/agent-tools/mcp-actions.ts.
 * (c) Copy-paste snippets for pointing an external MCP client
 *     (Claude Code / Claude Desktop / Cursor) at mcp.oxagen.sh.
 *
 * Registry administration deliberately does NOT live here — catalog sources
 * are managed in Settings → MCP Server Registries.
 */
export default async function AgentToolsMcpPage({
  params,
  searchParams,
}: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { reauth: reauthListingId } = await searchParams;
  const { org, ws } = await resolveWorkbenchScope(orgSlug, workspaceSlug);

  // (b) Installed mcp_server plugins for this workspace.
  const rows = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select()
          .from(schema.pluginInstalledPlugins)
          .where(
            and(
              eq(schema.pluginInstalledPlugins.orgId, org.id),
              eq(schema.pluginInstalledPlugins.workspaceId, ws.id),
              eq(schema.pluginInstalledPlugins.pluginType, "mcp_server"),
              isNull(schema.pluginInstalledPlugins.deletedAt),
            ),
          )
          .orderBy(schema.pluginInstalledPlugins.name),
      ),
  ).catch((err: unknown) => {
    logger.error(
      { err, orgSlug, workspaceSlug },
      "tools/mcp: installed-server read failed — rendering an empty list",
    );
    return [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[];
  });

  // Credential status per listing (status-only read, no decryption) — drives
  // the Connected / Needs authentication badges and Authenticate actions.
  const credentialStatuses = await listWorkspaceCredentialStatuses({
    orgId: org.id,
    workspaceId: ws.id,
  }).catch((err: unknown) => {
    logger.error(
      { err, orgSlug, workspaceSlug },
      "tools/mcp: credential-status read failed — every server shows as unauthenticated",
    );
    return [];
  });
  const statusByListing = new Map(
    credentialStatuses.map((c) => [c.orgListingId, c.status]),
  );

  const initialServers: McpServerRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    endpointUrl: row.endpointUrl,
    transport: row.transport,
    authKind: row.authKind,
    enabled: row.enabled,
    credentialStatus:
      (statusByListing.get(row.id) as McpServerRow["credentialStatus"]) ?? null,
  }));

  // orgListingId → display name for the OAuth result toast.
  const serverNames = Object.fromEntries(
    rows.map((row) => [row.id, row.title ?? row.name]),
  );

  // (c) Read the org's first active API key to inject into external-client snippets.
  let firstKey: string | null = null;
  try {
    const keys = await runInTenantScope(
      { orgId: org.id, workspaceId: ORG_ONLY_WS },
      () =>
        withTenantDb((tx) =>
          tx
            .select({
              keyPrefix: schema.apiKeys.keyPrefix,
              expiresAt: schema.apiKeys.expiresAt,
            })
            .from(schema.apiKeys)
            .where(eq(schema.apiKeys.orgId, org.id))
            .orderBy(desc(schema.apiKeys.createdAt))
            .limit(10),
        ),
    );
    const active = keys.filter((k) => !k.expiresAt || k.expiresAt > new Date());
    if (active[0]) {
      firstKey = `${active[0].keyPrefix}${"•".repeat(32)}`;
    }
  } catch (err) {
    // Degrade gracefully — snippets fall back to $OXAGEN_API_KEY — but never silently.
    logger.error(
      { err, orgSlug },
      "tools/mcp: API-key lookup for install snippets failed — using the $OXAGEN_API_KEY placeholder",
    );
  }

  const apiKeyDisplay = firstKey ?? "$OXAGEN_API_KEY";
  const snippetDefs = buildSnippets(apiKeyDisplay);
  const entries: McpTabEntry[] = await Promise.all(
    snippetDefs.map(async (s) => ({
      ...s,
      highlightedHtml: await highlight(
        s.raw,
        s.key === "claude_code" ? "bash" : "json",
      ),
    })),
  );

  return (
    <div className="flex flex-col gap-8">
      {/* OAuth flow outcome toast (?mcp=connected|error) — useSearchParams
          requires a Suspense boundary. */}
      <Suspense fallback={null}>
        <McpOauthResultToast serverNames={serverNames} />
      </Suspense>

      {/* ── Installed MCP servers ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">
            Installed MCP servers
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Servers this workspace can use. Authenticate or reconnect when a
            credential expires, remove authentication to force a fresh sign-in,
            or uninstall the server entirely.
          </p>
        </div>
        <McpServerList
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialServers={initialServers}
          toggleAction={togglePlugin}
          uninstallAction={uninstallPlugin}
          revokeAction={revokeMcpCredential}
          saveSecretAction={setMcpServerSecret}
          reauthListingId={reauthListingId ?? null}
        />
      </div>

      {/* ── Install from the marketplace ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">
            Install from the marketplace
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Search the marketplace catalog and install hosted servers into this
            workspace. OAuth-protected servers (Stripe, GitHub, …) prompt you to
            authenticate right after install. Catalog sources are administered
            in{" "}
            <a
              href={workspace.settings.mcpServerRegistries({
                orgSlug,
                workspaceSlug,
              })}
              className="font-medium underline underline-offset-2 hover:no-underline"
            >
              Settings → MCP Server Registries
            </a>
            .
          </p>
        </div>
        <McpCatalogSearch
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          installAction={installPlugin}
        />
      </div>

      {/* ── Connect a custom MCP server ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">
            Connect manually
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Point this workspace at any MCP-compatible server by endpoint URL.
          </p>
        </div>
        <ConnectMcpForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          connectAction={connectCustomMcpServer}
          saveSecretAction={setMcpServerSecret}
        />
      </div>

      {/* ── Connect an external MCP client to Oxagen ─────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4 flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">
            Connect an external client
          </h2>
          <p className="text-xs text-muted-foreground">
            Point Claude Code, Claude Desktop, Cursor, or any other MCP client
            at your Oxagen workspace.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <ExternalLink
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
            <span>
              The MCP endpoint is live at{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                {MCP_URL}
              </code>
              . Connect over streamable HTTP — no SSE path needed.
            </span>
          </div>

          {firstKey ? (
            <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
              <KeySquare
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                The snippets below use your org&apos;s first active API token
                (prefix shown). Replace with the full token value you saved when
                the key was created.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/12 px-4 py-3 text-sm text-warning">
              <KeySquare
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                No active API token found. Create one on the{" "}
                <a
                  href={`/${orgSlug}/developer/tokens`}
                  className="font-medium underline underline-offset-2 hover:no-underline"
                >
                  Tokens
                </a>{" "}
                tab, then replace{" "}
                <code className="font-mono text-xs">$OXAGEN_API_KEY</code> in
                the snippets below with your key value.
              </span>
            </div>
          )}

          <McpInstallTabs entries={entries} />
        </div>
      </div>
    </div>
  );
}
