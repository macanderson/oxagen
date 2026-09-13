"use client";

import * as React from "react";
import { GithubIcon, Link as LinkIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GitHubConnectionWizard } from "@/components/knowledge/connections/github-connection-wizard";
import { cn } from "@/lib/utils";

export interface ConnectionCreateInlineProps {
  /** Which connector to connect. Defaults to "github". */
  connectorId?: string;
  /** Injected by the stream route — needed for navigation context. */
  orgSlug?: string;
  workspaceSlug?: string;
}

export default function ConnectionCreateInline({
  connectorId = "github",
  orgSlug = "",
  workspaceSlug = "",
}: ConnectionCreateInlineProps): React.ReactElement {
  const [wizardOpen, setWizardOpen] = React.useState(false);

  if (connectorId === "github") {
    return (
      <>
        <div
          className={cn(
            "rounded-2xl border border-border bg-card p-5 space-y-4 w-full max-w-sm",
          )}
          data-testid="connection-create-inline-github"
        >
          <div className="flex items-center gap-2.5">
            <GithubIcon
              className="h-4 w-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="text-sm font-semibold text-foreground">
              Connect a GitHub repository
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Authorize Oxagen to read your repositories and start indexing
            commits, branches, and pull requests into your knowledge graph.
          </p>

          <Button
            type="button"
            onClick={() => setWizardOpen(true)}
            data-testid="connection-create-inline-github-btn"
          >
            Connect GitHub
          </Button>
        </div>

        <GitHubConnectionWizard
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </>
    );
  }

  // Fallback for connectors that don't have an inline connect flow yet.
  const sourcesHref =
    orgSlug && workspaceSlug
      ? `/${orgSlug}/${workspaceSlug}/knowledge/sources`
      : "/";

  return (
    <div
      className={cn(
        "rounded-2xl border border-border bg-card p-5 space-y-4 w-full max-w-sm",
      )}
      data-testid="connection-create-inline-fallback"
    >
      <div className="flex items-center gap-2.5">
        <LinkIcon
          className="h-4 w-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold text-foreground">
          Connect a source
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        Inline connect is not available for this connector yet. Open the Sources
        page to set it up manually.
      </p>

      <Link
        href={sourcesHref}
        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
        data-testid="connection-create-inline-sources-link"
      >
        Open Sources
      </Link>
    </div>
  );
}
