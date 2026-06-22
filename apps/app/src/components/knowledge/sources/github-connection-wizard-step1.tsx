"use client";

/**
 * github-connection-wizard-step1.tsx — Step 1 "Connect": creates a pending
 * connection row and redirects to GitHub OAuth.
 */

import * as React from "react";
import { GithubIcon } from "lucide-react";
import { API_BASE } from "./github-connection-wizard-types";
import { Spinner } from "./github-connection-wizard-spinner";

export interface Step1Props {
  orgSlug: string;
  workspaceSlug: string;
  onConnectionCreated: (connectionId: string) => void;
  error: string | null;
}

export function Step1Connect({ orgSlug, workspaceSlug, onConnectionCreated, error }: Step1Props) {
  const [loading, setLoading] = React.useState(false);
  const [localError, setLocalError] = React.useState<string | null>(null);

  const handleConnect = React.useCallback(async () => {
    setLoading(true);
    setLocalError(null);
    try {
      // Step 1a: Create connection row in pending_setup status.
      const createRes = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          // Shape is the connection.create contract input. The credential
          // carries only its type — real tokens arrive via the OAuth
          // callback after the GitHub redirect, never through this POST.
          body: JSON.stringify({
            connectorId: "github",
            displayName: "GitHub",
            authCredential: { type: "oauth2_authorization_code" },
            connectionConfig: { organizations: [], syncDepthDays: 90 },
          }),
        },
      );
      if (!createRes.ok) {
        const text = await createRes.text().catch(() => "Unknown error");
        throw new Error(`Failed to create connection: ${text}`);
      }
      const created = (await createRes.json()) as { publicId?: string; connectionId?: string };
      const connectionId = created.publicId ?? created.connectionId;
      if (!connectionId) throw new Error("No connectionId returned from create");

      onConnectionCreated(connectionId);

      // Step 1b: Get the OAuth URL and redirect.
      const authUrlRes = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/github/auth-url?connectionId=${connectionId}`,
        { credentials: "include" },
      );
      if (!authUrlRes.ok) {
        // Surface the API's actual error (e.g. a 503 "GitHub App is not
        // configured") instead of a generic message — a misconfigured
        // deployment is otherwise undiagnosable from the UI. Mirrors how
        // the connection-create step above reads its error body.
        const body = (await authUrlRes.json().catch(() => null)) as { error?: string } | null;
        throw new Error(
          body?.error
            ? `Failed to get OAuth URL: ${body.error}`
            : `Failed to get OAuth URL (${authUrlRes.status})`,
        );
      }
      const { authUrl } = (await authUrlRes.json()) as { authUrl: string };
      window.location.href = authUrl;
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : "Failed to initiate GitHub connection");
      setLoading(false);
    }
  }, [orgSlug, workspaceSlug, onConnectionCreated]);

  const displayError = localError ?? error;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <GithubIcon className="h-8 w-8 text-foreground" aria-hidden="true" />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold text-foreground">Connect your GitHub account</p>
          <p className="text-xs text-muted-foreground max-w-xs">
            Authorize Oxagen to read your repositories. You&apos;ll select which repos to sync
            in the next step.
          </p>
        </div>
      </div>

      {displayError && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {displayError}
        </p>
      )}

      <button
        type="button"
        className="flex w-full items-center justify-center gap-2 rounded-md bg-foreground px-4 py-2.5 text-sm font-semibold text-background hover:bg-foreground/90 transition-colors disabled:opacity-50"
        disabled={loading}
        onClick={handleConnect}
        data-testid="github-connect-btn"
      >
        {loading ? <Spinner /> : <GithubIcon className="h-4 w-4" aria-hidden="true" />}
        {loading ? "Redirecting to GitHub…" : "Connect with GitHub"}
      </button>
    </div>
  );
}
