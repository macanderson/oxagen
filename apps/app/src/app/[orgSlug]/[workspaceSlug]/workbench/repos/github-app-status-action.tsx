"use client";

/**
 * github-app-status-action.tsx — compact "Connect GitHub App" / "Disconnect"
 * header action for the Repos list.
 *
 * Reuses `fetchGithubStatus` from lib/github.ts (already shared by the
 * Settings → GitHub panel and the Knowledge → Sources connect wizard — see
 * apps/app/src/lib/github.ts's own doc comment) instead of forking that
 * whole connection-lifecycle panel. There is no in-app "disconnect" capability
 * for the GitHub App install (matches Settings → GitHub, which only offers
 * Reconnect + an external "Manage GitHub App access" link) — uninstalling is
 * a GitHub-side action, so "Disconnect" here is that same external manage
 * link, opened in a new tab.
 */

import * as React from "react";
import { Github, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchGithubStatus, type GithubStatusResponse } from "@/lib/github";
import { workspace } from "@/lib/routes";

export interface GithubAppStatusActionProps {
  orgSlug: string;
  workspaceSlug: string;
  /**
   * Variant for the "Connect GitHub App" button. Defaults to `outline` (the
   * compact header treatment); the zero-repo empty state passes `default` so
   * Connect reads as the guided primary action. The connected "Manage" state
   * always stays `ghost` regardless — managing is never the primary path.
   */
  connectVariant?: "default" | "outline";
}

export function GithubAppStatusAction({
  orgSlug,
  workspaceSlug,
  connectVariant = "outline",
}: GithubAppStatusActionProps) {
  const [status, setStatus] = React.useState<GithubStatusResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    fetchGithubStatus(orgSlug, workspaceSlug, controller.signal).then(
      (s) => {
        if (!controller.signal.aborted) setStatus(s);
      },
      (e) => {
        if (!controller.signal.aborted) {
          setError(
            e instanceof Error ? e.message : "Failed to load GitHub status.",
          );
        }
      },
    );
    return () => controller.abort();
  }, [orgSlug, workspaceSlug]);

  const settingsHref = workspace.settings.github({ orgSlug, workspaceSlug });

  if (error) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="repos-github-status-error"
      >
        GitHub App status unavailable —{" "}
        <a href={settingsHref} className="text-primary hover:underline">
          check Settings → GitHub
        </a>
        .
      </p>
    );
  }

  if (!status) {
    return (
      <div
        className="h-8 w-40 animate-pulse rounded-md bg-muted"
        aria-hidden="true"
      />
    );
  }

  if (!status.connected) {
    return (
      <Button
        variant={connectVariant}
        size="sm"
        data-testid="repos-connect-github-btn"
        render={<a href={status.identityUrl} />}
      >
        <Github aria-hidden="true" />
        Connect GitHub App
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="repos-manage-github-btn"
      render={
        <a href={status.manageUrl} target="_blank" rel="noopener noreferrer" />
      }
    >
      <ExternalLink aria-hidden="true" />
      Manage / disconnect GitHub App
    </Button>
  );
}
