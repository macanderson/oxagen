/**
 * Developer → MCP page — the install snippets for an MCP client.
 *
 * The snippets name `$OXAGEN_API_KEY` and never a key value. This page used to
 * read the org's first active key to inject it, but `auth.api_keys` keeps only
 * `key_prefix` and `key_hash`, so what it could inject was a masked prefix that
 * cannot authenticate — see the comment on the snippet build below.
 */

import { ExternalLink, KeySquare } from "lucide-react";
import { assertOrgMember, resolveOrg } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { Panel } from "@/components/ui/panel";
import { McpInstallTabs } from "./mcp-install-tabs";
import type { McpTabEntry } from "./mcp-install-tabs";
import { MCP_URL, buildSnippets } from "./mcp-install-snippets";

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

  // NO KEY IS READ HERE, DELIBERATELY. The snippets carry `$OXAGEN_API_KEY`
  // and always have.
  //
  // A previous revision of this change widened the read so the page could show
  // the org's first active key — but `auth.api_keys` keeps only `key_prefix`
  // and `key_hash`, so the best it could build was `ox_abc••••••••`, and
  // buildSnippets embeds that string as the bearer credential. A copied Claude
  // or Cursor config would then be GUARANTEED to fail authentication, where the
  // environment-variable placeholder resolves to the secret the operator
  // actually saved. The raw key cannot be recovered after creation, so there is
  // nothing better to put here, and a snippet that cannot work is worse than
  // one that asks for the secret — it looks copy-pasteable.
  //
  // Which is this PR's own lesson once more: correct the read, then print
  // something that cannot be right.
  const snippetDefs = buildSnippets();

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

          {/* API key notice — the snippets always name the env var. */}
          <div className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            <KeySquare className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>
              The Claude Code command names{" "}
              <code className="font-mono text-xs">$OXAGEN_API_KEY</code>, which
              your shell expands. The JSON configs cannot expand anything, so
              replace{" "}
              <code className="font-mono text-xs">&lt;your-api-key&gt;</code> in
              them with the key value you saved when the key was created — it is
              shown once and cannot be read back. Create one on the{" "}
              <a
                href={`/${orgSlug}/developer/tokens`}
                className="font-medium underline underline-offset-2 hover:no-underline"
              >
                Tokens
              </a>{" "}
              tab.
            </span>
          </div>

          {/* Install tabs */}
          <McpInstallTabs entries={entries} />
        </div>
      </Panel>
    </div>
  );
}
