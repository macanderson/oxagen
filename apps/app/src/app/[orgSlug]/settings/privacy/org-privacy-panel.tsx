"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  requestOrgDataExportAction,
  requestOrgDataEraseAction,
  getOrgExportStatusAction,
} from "./org-privacy-actions";

/** How often the queued export is re-checked, in milliseconds. */
const EXPORT_POLL_INTERVAL_MS = 5000;
/**
 * Stop polling after this many checks (~10 minutes). An export that is still
 * neither "ready" nor "failed" by then is almost certainly stuck; polling
 * forever would keep hitting a server action for the life of the tab.
 */
const EXPORT_POLL_MAX_ATTEMPTS = 120;

export function OrgPrivacyPanel({ orgSlug }: { orgSlug: string }) {
  const [exportState, setExportState] = React.useState<
    | { phase: "idle" }
    | { phase: "pending" }
    | { phase: "queued"; exportId: string }
    | { phase: "ready"; downloadUrl: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  const [eraseState, setEraseState] = React.useState<
    | { phase: "idle" }
    | { phase: "confirming" }
    | { phase: "pending" }
    | { phase: "queued"; effectiveAt: string }
    | { phase: "error"; message: string }
  >({ phase: "idle" });

  // The poll timer is held in a ref so it can be cancelled on unmount. Without
  // that cleanup the interval outlives the panel: navigating away leaves a
  // server action firing every few seconds for the life of the tab, and its
  // callback keeps calling setState on an unmounted component.
  const pollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = React.useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  React.useEffect(() => stopPolling, [stopPolling]);

  const handleExport = async () => {
    setExportState({ phase: "pending" });
    try {
      const result = await requestOrgDataExportAction(orgSlug);
      setExportState({ phase: "queued", exportId: result.exportId });
      stopPolling();
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts += 1;
        const status = await getOrgExportStatusAction(orgSlug, result.exportId);
        if (status?.status === "ready" && status.exportUrl) {
          stopPolling();
          setExportState({ phase: "ready", downloadUrl: status.exportUrl });
        } else if (status?.status === "failed") {
          stopPolling();
          setExportState({
            phase: "error",
            message: "Export failed. Please try again.",
          });
        } else if (attempts >= EXPORT_POLL_MAX_ATTEMPTS) {
          stopPolling();
          setExportState({
            phase: "error",
            message:
              "Export is taking longer than expected. Reload this page to check again.",
          });
        }
      }, EXPORT_POLL_INTERVAL_MS);
    } catch (err) {
      stopPolling();
      setExportState({
        phase: "error",
        message: err instanceof Error ? err.message : "Export failed",
      });
    }
  };

  const handleErase = async () => {
    setEraseState({ phase: "pending" });
    try {
      const result = await requestOrgDataEraseAction(orgSlug);
      setEraseState({ phase: "queued", effectiveAt: result.effectiveAt });
    } catch (err) {
      setEraseState({
        phase: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    }
  };

  return (
    <div className="flex flex-col gap-8 max-w-xl">
      {/* Organization Data Export */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Export organization data</h3>
        <p className="text-sm text-muted-foreground">
          Download a machine-readable ZIP archive of all organization data,
          including member profiles, workspace configurations, conversations,
          and generated assets. Requires Owner or Admin role. (GDPR Article 20)
        </p>
        {exportState.phase === "idle" && (
          <Button
            variant="outline"
            size="sm"
            className="w-fit max-md:h-11"
            onClick={handleExport}
          >
            Request organization export
          </Button>
        )}
        {exportState.phase === "pending" && (
          <p className="text-sm text-muted-foreground">Submitting request…</p>
        )}
        {exportState.phase === "queued" && (
          <p className="text-sm text-muted-foreground">
            Organization export is being prepared. This may take several
            minutes.
          </p>
        )}
        {exportState.phase === "ready" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-success">Export ready.</p>
            <a
              href={exportState.downloadUrl}
              download
              className="text-sm underline underline-offset-4"
            >
              Download ZIP archive
            </a>
          </div>
        )}
        {exportState.phase === "error" && (
          <p className="text-sm text-destructive">{exportState.message}</p>
        )}
      </section>

      <hr className="border-border" />

      {/* Organization Erasure */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-destructive">
          Delete organization
        </h3>
        <p className="text-sm text-muted-foreground">
          Permanently delete this organization and all associated data — all
          workspaces, members, conversations, and assets. This action requires
          Owner or Admin role and cannot be undone. (GDPR Article 17)
        </p>
        {eraseState.phase === "idle" && (
          <Button
            variant="destructive"
            size="sm"
            className="w-fit max-md:h-11"
            onClick={() => setEraseState({ phase: "confirming" })}
          >
            Delete organization
          </Button>
        )}
        {eraseState.phase === "confirming" && (
          <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium">
              This will permanently delete the entire organization. All members
              will be offboarded and all data erased. This cannot be undone.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                size="sm"
                className="max-md:h-11"
                onClick={handleErase}
              >
                Yes, delete organization
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="max-md:h-11"
                onClick={() => setEraseState({ phase: "idle" })}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        {eraseState.phase === "pending" && (
          <p className="text-sm text-muted-foreground">Processing…</p>
        )}
        {eraseState.phase === "queued" && (
          <p className="text-sm">
            Organization deletion has been scheduled. Effective date:{" "}
            <span className="font-medium">
              {new Date(eraseState.effectiveAt).toLocaleDateString()}
            </span>
            .
          </p>
        )}
        {eraseState.phase === "error" && (
          <p className="text-sm text-destructive">{eraseState.message}</p>
        )}
      </section>
    </div>
  );
}
