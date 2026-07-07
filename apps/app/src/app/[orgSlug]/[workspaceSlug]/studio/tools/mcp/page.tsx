import type { Metadata } from "next";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ExternalLink, KeySquare } from "lucide-react";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import "@oxagen/handlers/register";
import { resolveStudioScope } from "@/lib/studio/scope";
import { togglePlugin, uninstallPlugin } from "@/lib/agent-tools/install-actions";
import { connectCustomMcpServer } from "@/lib/agent-tools/mcp-actions";
import { GithubMcpCard } from "@/components/agent-tools/github-mcp-card";
import {
  installGithubMcp,
  getGithubMcpInstallStatus,
} from "@/lib/agent-tools/github-mcp-actions";
import { ConnectMcpForm } from "./connect-mcp-form";
import { McpServerList, type McpServerRow } from "./mcp-server-list";
// McpInstallTabs is the presentational client component that renders the
// per-client copy-paste install snippets — reused verbatim from
// Developer → MCP (apps/app/src/app/[orgSlug]/developer/mcp/) rather than
// re-implemented, since it's a pure props-in component with no org-page
// server logic baked in.
import { McpInstallTabs, type McpTabEntry } from "../../../../developer/mcp/mcp-install-tabs";

export const metadata: Metadata = {
  title: "MCP Servers | Agent Tools",
};

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

const MCP_URL = "https://mcp.oxagen.sh/mcp";
// Sentinel workspaceId for org-only reads (API keys are org-scoped) — mirrors
// developer/mcp/page.tsx's ORG_ONLY_WS.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

/** Build the install snippets with a real (or placeholder) API key. */
function buildSnippets(apiKey: string): Array<Omit<McpTabEntry, "highlightedHtml">> {
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
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre><code>${escaped}</code></pre>`;
  }
}

/**
 * Studio → Agent Tools → MCP Servers.
 *
 * (a) Connect a custom MCP server by endpoint (plugin.org.install, mcp_server,
 *     custom endpoint) — see @/lib/agent-tools/mcp-actions.ts /
 *     connect-mcp-form.tsx.
 * (b) List installed mcp_server plugins for this workspace, with the same
 *     toggle/uninstall actions as the Capabilities tab.
 * (c) Copy-paste snippets for pointing an external MCP client
 *     (Claude Code / Claude Desktop / Cursor) at mcp.oxagen.sh.
 */
export default async function AgentToolsMcpPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const { org, ws } = await resolveStudioScope(orgSlug, workspaceSlug);

  // Featured first-party server: GitHub MCP (non-fatal: card degrades to
  // not-installed, with the failure logged).
  const githubMcpStatus = await getGithubMcpInstallStatus({ orgSlug, workspaceSlug }).catch(
    (e: unknown) => {
      console.error("GitHub MCP status lookup failed:", e);
      return {
        installed: false,
        orgListingId: null,
        connected: false,
        healthStatus: null,
      };
    },
  );

  // (b) Installed mcp_server plugins for this workspace.
  const rows = await runInTenantScope({ orgId: org.id, workspaceId: ws.id }, () =>
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
  ).catch((e: unknown) => {
    console.error("installed MCP server query failed:", e);
    return [] as (typeof schema.pluginInstalledPlugins.$inferSelect)[];
  });

  const initialServers: McpServerRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    endpointUrl: row.endpointUrl,
    transport: row.transport,
    authKind: row.authKind,
    enabled: row.enabled,
  }));

  // (c) Read the org's first active API key to inject into external-client snippets.
  let firstKey: string | null = null;
  try {
    const keys = await runInTenantScope({ orgId: org.id, workspaceId: ORG_ONLY_WS }, () =>
      withTenantDb((tx) =>
        tx
          .select({ keyPrefix: schema.apiKeys.keyPrefix, expiresAt: schema.apiKeys.expiresAt })
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
  } catch (e) {
    // Degrade gracefully — snippets fall back to $OXAGEN_API_KEY — but never silently.
    console.error("API key lookup for MCP snippets failed:", e);
  }

  const apiKeyDisplay = firstKey ?? "$OXAGEN_API_KEY";
  const snippetDefs = buildSnippets(apiKeyDisplay);
  const entries: McpTabEntry[] = await Promise.all(
    snippetDefs.map(async (s) => ({
      ...s,
      highlightedHtml: await highlight(s.raw, s.key === "claude_code" ? "bash" : "json"),
    })),
  );

  return (
    <div className="flex flex-col gap-8">
      {/* ── Featured servers ─────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Featured Servers
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <GithubMcpCard
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            installed={githubMcpStatus.installed}
            orgListingId={githubMcpStatus.orgListingId}
            connected={githubMcpStatus.connected}
            healthStatus={githubMcpStatus.healthStatus}
            installAction={installGithubMcp}
          />
        </div>
      </section>

      {/* ── Connect a custom MCP server ─────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">Connect a custom MCP server</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Point this workspace at any MCP-compatible server by endpoint URL.
          </p>
        </div>
        <ConnectMcpForm
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          connectAction={connectCustomMcpServer}
        />
      </div>

      {/* ── Installed MCP servers ────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-foreground">Installed MCP servers</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            MCP servers connected to this workspace, from the catalog or a custom endpoint.
          </p>
        </div>
        <McpServerList
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          initialServers={initialServers}
          toggleAction={togglePlugin}
          uninstallAction={uninstallPlugin}
        />
      </div>

      {/* ── Connect an external MCP client to Oxagen ─────────────────────────── */}
      <div className="rounded-xl border border-border/60 bg-card p-6">
        <div className="mb-4 flex flex-col gap-1">
          <h2 className="text-sm font-semibold text-foreground">Connect an external client</h2>
          <p className="text-xs text-muted-foreground">
            Point Claude Code, Claude Desktop, Cursor, or any other MCP client at your Oxagen
            workspace.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <ExternalLink className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
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
              <KeySquare className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                The snippets below use your org&apos;s first active API token (prefix shown).
                Replace with the full token value you saved when the key was created.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/12 px-4 py-3 text-sm text-warning">
              <KeySquare className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                No active API token found. Create one on the{" "}
                <a
                  href={`/${orgSlug}/developer/tokens`}
                  className="font-medium underline underline-offset-2 hover:no-underline"
                >
                  Tokens
                </a>{" "}
                tab, then replace{" "}
                <code className="font-mono text-xs">$OXAGEN_API_KEY</code> in the snippets below
                with your key value.
              </span>
            </div>
          )}

          <McpInstallTabs entries={entries} />
        </div>
      </div>
    </div>
  );
}
