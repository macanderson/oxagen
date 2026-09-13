/**
 * Developer → MCP page — live API key injection.
 *
 * Reads the org's first active API key (same query as the tokens page) and
 * injects it into the install snippets so the copy-paste actually works.
 * Falls back gracefully when no API key exists: shows a note to create one.
 */

import { desc, eq } from "drizzle-orm";
import { ExternalLink, KeySquare } from "lucide-react";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { resolveOrg, assertOrgMember } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { Panel } from "@/components/ui/panel";
import { McpInstallTabs } from "./mcp-install-tabs";
import type { McpTabEntry } from "./mcp-install-tabs";

// Sentinel workspaceId for org-only routes.
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

const MCP_URL = "https://mcp.oxagen.sh/mcp";

/** Build the install snippets with a real (or placeholder) API key. */
function buildSnippets(apiKey: string): Omit<McpTabEntry, "highlightedHtml">[] {
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

/**
 * Shiki is an optional enhancement — fall back to plain text on failure.
 *
 * A single vibrant dark theme is used in BOTH light and dark app modes: the code
 * block renders on the always-dark ember-framed terminal surface (`.ox-code-frame`),
 * so a light syntax theme would be unreadable. `one-dark-pro` gives punchy,
 * high-contrast token colours that pop against the dark fill.
 */
async function highlight(code: string, lang: string): Promise<string> {
  try {
    const { codeToHtml } = await import("shiki");
    return await codeToHtml(code, {
      lang,
      theme: "one-dark-pro",
    });
  } catch {
    // Shiki not available or failed — return plain pre-escaped HTML.
    const escaped = code
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre><code>${escaped}</code></pre>`;
  }
}

export default async function DeveloperMcpPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);

  const viewerUserId = session?.user?.id ?? "";
  if (viewerUserId) {
    await assertOrgMember(org.id, viewerUserId);
  }

  // Read the first active API key for this org.
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
      // Show the key prefix only — the full hash is never readable after creation.
      firstKey = `${active[0].keyPrefix}${"•".repeat(32)}`;
    }
  } catch {
    // DB unreachable — degrade gracefully.
  }

  // Build snippets with real key or placeholder.
  const apiKeyDisplay = firstKey ?? "$OXAGEN_API_KEY";
  const snippetDefs = buildSnippets(apiKeyDisplay);

  // Highlight each snippet. Shell snippets use "bash", JSON uses "json".
  const entries: McpTabEntry[] = await Promise.all(
    snippetDefs.map(async (s) => {
      const lang = s.key === "claude_code" ? "bash" : "json";
      return {
        ...s,
        highlightedHtml: await highlight(s.raw, lang),
      };
    }),
  );

  return (
    <div className="flex flex-col gap-6">
      <Panel title="MCP server">
        <div className="flex flex-col gap-6">
          <p className="text-sm text-muted-foreground">
            Connect any MCP-compatible agent client to your Oxagen workspace.
          </p>
          {/* Endpoint notice */}
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

          {/* API key notice */}
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

          {/* Install tabs */}
          <McpInstallTabs entries={entries} />
        </div>
      </Panel>
    </div>
  );
}
