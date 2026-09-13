"use client";

/**
 * github-connection-wizard-step1.tsx — Gate shown when the workspace GitHub App
 * is not yet installed. Directs the user to Workspace Settings → GitHub rather
 * than running the OAuth redirect here; install (1 workspace = 1 app install)
 * now lives in settings.
 */

import * as React from "react";
import { GithubIcon } from "lucide-react";
import { workspace } from "@/lib/routes";

export interface GitHubInstallGateProps {
  orgSlug: string;
  workspaceSlug: string;
  onClose: () => void;
}

export function GitHubInstallGate({
  orgSlug,
  workspaceSlug,
  onClose,
}: GitHubInstallGateProps) {
  const settingsHref = workspace.settings.github({ orgSlug, workspaceSlug });

  return (
    <div className="flex flex-col gap-6" data-testid="github-install-gate">
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <GithubIcon className="h-8 w-8 text-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">
            Install the GitHub App
          </p>
          <p className="text-xs text-muted-foreground max-w-xs">
            The Oxagen GitHub App must be installed for this workspace before
            you can add repositories. Visit Workspace Settings to connect it.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <a
          href={settingsHref}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-semibold text-background hover:bg-foreground/90 transition-colors"
          data-testid="github-gate-settings-link"
        >
          <GithubIcon className="h-4 w-4" aria-hidden="true" />
          Open GitHub settings
        </a>
        <button
          type="button"
          className="rounded-md border border-border/60 bg-card px-4 py-2 text-sm text-muted-foreground hover:bg-muted transition-colors"
          onClick={onClose}
          data-testid="github-gate-cancel-btn"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
