"use client";
/**
 * github-mcp-card.tsx — Featured card for the GitHub MCP first-party integration.
 *
 * Renders a prominent install+connect card in the Workspace → Settings → Plugins
 * page. The flow is:
 *   1. "Install & Connect" → calls installGithubMcp server action.
 *   2. On success, the browser is redirected to the OAuth authorize URL
 *      (/api/v1/mcp/oauth/authorize) which drives the GitHub OAuth 2.1 flow.
 *   3. After OAuth completes, the user lands back on /settings/integrations?mcp=connected.
 *
 * When already installed+connected, shows a "Reconnect" link and a health badge.
 */
import * as React from "react";
import { ExternalLink, GitBranch, Github } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { installGithubMcp } from "./github-mcp-actions";

// Inline first-party descriptor constants (avoids @oxagen/plugins in client bundle).
const GITHUB_MCP_TITLE = "GitHub MCP";
const GITHUB_MCP_DESCRIPTION =
  "Read repositories, create branches, open pull requests, list and comment on issues — all via GitHub's hosted MCP server.";
const GITHUB_MCP_DOCS_URL = "https://github.com/github/github-mcp-server";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GithubMcpCardProps {
  orgSlug: string;
  workspaceSlug: string;
  /** True when the plugin.installed_plugins row exists for this workspace. */
  installed: boolean;
  /** UUID of the plugin.installed_plugins row (null when not installed). */
  orgListingId: string | null;
  /** True when the mcp_servers row exists and health_status = "healthy". */
  connected: boolean;
  /** Raw health status from mcp_servers (null when not connected). */
  healthStatus: string | null;
  installAction: typeof installGithubMcp;
}

// ── GithubMcpCard ─────────────────────────────────────────────────────────────

export function GithubMcpCard({
  orgSlug,
  workspaceSlug,
  installed,
  orgListingId,
  connected,
  healthStatus,
  installAction,
}: GithubMcpCardProps) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const authorizeUrl = orgListingId
    ? `/api/v1/mcp/oauth/authorize` +
      `?orgSlug=${encodeURIComponent(orgSlug)}` +
      `&workspaceSlug=${encodeURIComponent(workspaceSlug)}` +
      `&orgListingId=${encodeURIComponent(orgListingId)}`
    : null;

  async function handleInstallAndConnect() {
    setPending(true);
    setError(null);

    const result = await installAction({ orgSlug, workspaceSlug });
    if (!result.ok || !result.authorizeUrl) {
      setError(result.error ?? "Installation failed. Please try again.");
      setPending(false);
      return;
    }

    // Navigate to the MCP OAuth authorize route (server-side redirect to GitHub).
    window.location.href = result.authorizeUrl;
    // Keep pending spinner active during navigation.
  }

  return (
    <div
      className="rounded-lg border border-border bg-card p-5 flex flex-col gap-4"
      data-testid="github-mcp-card"
    >
      {/* Header row */}
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          {/* Use Github lucide icon as fallback; prefer the real favicon if renderable */}
          <Github className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold leading-tight">
              {GITHUB_MCP_TITLE}
            </h3>
            <Badge variant="info" size="sm">
              mcp server
            </Badge>
            <Badge variant="muted" size="sm">
              oauth
            </Badge>
            {connected && (
              <Badge variant="success" size="sm" data-testid="github-mcp-connected-badge">
                connected
              </Badge>
            )}
            {installed && !connected && healthStatus && (
              <Badge variant="destructive" size="sm">
                {healthStatus}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {GITHUB_MCP_DESCRIPTION}
          </p>
        </div>
      </div>

      {/* Capability list */}
      <ul className="flex flex-wrap gap-2">
        {[
          "Read repos",
          "Create branches",
          "Open pull requests",
          "List issues",
          "Comment on issues",
          "Write files",
        ].map((cap) => (
          <li key={cap}>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
              <GitBranch className="h-3 w-3" aria-hidden="true" />
              {cap}
            </span>
          </li>
        ))}
      </ul>

      {/* Error message */}
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="github-mcp-error">
          {error}
        </p>
      )}

      {/* Action row */}
      <div className="flex items-center gap-2 flex-wrap">
        {!installed ? (
          <Button
            size="sm"
            onClick={handleInstallAndConnect}
            disabled={pending}
            data-testid="github-mcp-install-btn"
          >
            {pending ? "Connecting…" : "Install & Connect"}
          </Button>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              render={<a href={authorizeUrl ?? "#"} rel="noopener noreferrer" />}
              data-testid="github-mcp-reconnect-btn"
            >
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              {connected ? "Reconnect" : "Connect"}
            </Button>
          </>
        )}

        <Button
          variant="ghost"
          size="sm"
          render={
            <a
              href={GITHUB_MCP_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
            />
          }
        >
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Docs
        </Button>
      </div>
    </div>
  );
}
