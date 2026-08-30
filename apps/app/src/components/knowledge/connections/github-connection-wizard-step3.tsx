"use client";

/**
 * github-connection-wizard-step3.tsx — Step 3 "Confirm": review selection,
 * set sync depth, and trigger the initial sync.
 */

import * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { DialogFooter } from "@oxagen/ui";
import {
  type SyncDepth,
  SYNC_DEPTH_OPTIONS,
  API_BASE,
} from "./github-connection-wizard-types";
import type { SelectedRepoMeta } from "./github-connection-wizard-step2";
import { Spinner } from "./github-connection-wizard-spinner";

export interface Step3Props {
  orgSlug: string;
  workspaceSlug: string;
  connectionId: string;
  selectedInstallationId: string;
  /** Full repo metadata — needed to forward defaultBranch to the API. */
  selectedRepos: SelectedRepoMeta[];
  onSuccess: () => void;
}

export function Step3Confirm({
  orgSlug,
  workspaceSlug,
  connectionId,
  selectedInstallationId,
  selectedRepos,
  onSuccess,
}: Step3Props) {
  const [syncDepth, setSyncDepth] = React.useState<SyncDepth>(90);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleStartSync = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Derive owner/repo/defaultBranch from the first selected repo. The wizard
      // currently supports selecting multiple repos but ingestion is kicked off
      // for each repo individually. For the initial sync we use selectedRepos[0]
      // as the primary; additional repos will be wired in a follow-up.
      const primaryRepo = selectedRepos[0];
      const [owner = "", repo = ""] = primaryRepo?.fullName.split("/") ?? [];
      const defaultBranch = primaryRepo?.defaultBranch ?? "main";

      const res = await fetch(
        `${API_BASE}/v1/${orgSlug}/${workspaceSlug}/connections/${connectionId}/mappings`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connectionId,
            mappings: [
              {
                sourceRecordType: "repository",
                oxagenEntityType: "source_repository",
                propertyMappings: {
                  full_name: "display_name",
                  html_url: "url",
                  description: "description",
                  language: "language",
                },
              },
            ],
            activateConnection: true,
            installationId: selectedInstallationId,
            selectedRepos: selectedRepos.map((r) => r.fullName),
            syncDepthDays: syncDepth,
            // Explicit delivery config fields — persisted to deliveryConfig by
            // the handler before the ingestion event is fired. Without these the
            // handler reads an empty deliveryConfig and fires the event with
            // owner='' repo='' → GitHub returns 404 → 0 nodes written.
            owner,
            repo,
            defaultBranch,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(`Failed to start sync: ${text}`);
      }
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start sync");
      setLoading(false);
    }
  }, [
    orgSlug,
    workspaceSlug,
    connectionId,
    selectedInstallationId,
    selectedRepos,
    syncDepth,
    onSuccess,
  ]);

  return (
    <div className="flex flex-col gap-5">
      {/* Summary */}
      <div className="rounded-lg border border-border/60 bg-card/50 p-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Organization</span>
            <span className="font-medium text-foreground">
              Installation #{selectedInstallationId}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Repositories</span>
            <span className="font-medium text-foreground">
              {selectedRepos.length} selected
            </span>
          </div>
        </div>
        {selectedRepos.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {selectedRepos.slice(0, 6).map((r) => (
              <li
                key={r.fullName}
                className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {r.fullName}
              </li>
            ))}
            {selectedRepos.length > 6 && (
              <li className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                +{selectedRepos.length - 6} more
              </li>
            )}
          </ul>
        )}
      </div>

      {/* Sync depth */}
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">
          Sync history depth:{" "}
          <span className="text-foreground font-semibold">
            {syncDepth} days
          </span>
        </p>
        <div className="flex gap-1.5">
          {SYNC_DEPTH_OPTIONS.map((depth) => (
            <button
              key={depth}
              type="button"
              className={`flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                syncDepth === depth
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border/60 bg-card text-muted-foreground hover:bg-muted"
              }`}
              onClick={() => setSyncDepth(depth)}
              data-testid={`sync-depth-${depth}`}
            >
              {depth}d
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <DialogFooter>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          disabled={loading}
          onClick={handleStartSync}
          data-testid="start-sync-btn"
        >
          {loading ? (
            <>
              <Spinner />
              Starting sync…
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              Start Sync
            </>
          )}
        </button>
      </DialogFooter>
    </div>
  );
}
