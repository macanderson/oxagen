"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  requestUserDataExportAction,
  requestUserDataEraseAction,
  getExportStatusAction,
} from "./privacy-actions";

/** How often the queued export is re-checked, and for how long (5s × 120 = 10 min). */
const EXPORT_POLL_INTERVAL_MS = 5000;
const EXPORT_POLL_MAX_ATTEMPTS = 120;

export function UserPrivacyPanel() {
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

  const handleExport = async () => {
    setExportState({ phase: "pending" });
    try {
      const result = await requestUserDataExportAction();
      setExportState({ phase: "queued", exportId: result.exportId });
    } catch (err) {
      setExportState({
        phase: "error",
        message: err instanceof Error ? err.message : "Export failed",
      });
    }
  };

  // Poll the queued export until it is ready, fails, or the budget runs out.
  // Driven by an effect (not an interval started inside the click handler) so
  // navigating away clears it: an interval owned by the handler outlives the
  // unmounted component, keeps hitting the server action every 5s forever, and
  // has no terminal state for an export that is stuck "pending".
  const exportId = exportState.phase === "queued" ? exportState.exportId : null;
  React.useEffect(() => {
    if (exportId === null) return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(async () => {
      attempts += 1;
      if (attempts > EXPORT_POLL_MAX_ATTEMPTS) {
        clearInterval(timer);
        if (!cancelled) {
          setExportState({
            phase: "error",
            message:
              "Your export is taking longer than expected. Reload this page to check on it.",
          });
        }
        return;
      }
      try {
        const status = await getExportStatusAction(exportId);
        if (cancelled) return;
        if (status?.status === "ready" && status.exportUrl) {
          clearInterval(timer);
          setExportState({ phase: "ready", downloadUrl: status.exportUrl });
        } else if (status?.status === "failed") {
          clearInterval(timer);
          setExportState({
            phase: "error",
            message: "Export failed. Please try again.",
          });
        }
      } catch {
        // A transient status-read failure is not an export failure — keep
        // polling until the attempt budget is spent.
      }
    }, EXPORT_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [exportId]);

  const handleErase = async () => {
    setEraseState({ phase: "pending" });
    try {
      const result = await requestUserDataEraseAction();
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
      {/* Data Export — Art.20 */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold">Export your data</h3>
        <p className="text-sm text-muted-foreground">
          Download a machine-readable ZIP archive of your personal data,
          including your profile, conversations, API key metadata, and generated
          assets. (GDPR Article 20)
        </p>

        {exportState.phase === "idle" && (
          <Button
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={handleExport}
          >
            Request data export
          </Button>
        )}
        {exportState.phase === "pending" && (
          <p className="text-sm text-muted-foreground">Submitting request…</p>
        )}
        {exportState.phase === "queued" && (
          <p className="text-sm text-muted-foreground">
            Your data export is being prepared. This page will update when
            it&apos;s ready (usually within a few minutes).
          </p>
        )}
        {exportState.phase === "ready" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-success">Your export is ready.</p>
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

      {/* Account Erasure — Art.17 */}
      <section className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-destructive">
          Delete your account
        </h3>
        <p className="text-sm text-muted-foreground">
          Permanently delete your account and all associated personal data. Your
          sessions will be revoked immediately. Data deletion is scheduled
          within 30 days. This action cannot be undone. (GDPR Article 17)
        </p>

        {eraseState.phase === "idle" && (
          <Button
            variant="destructive"
            size="sm"
            className="w-fit"
            onClick={() => setEraseState({ phase: "confirming" })}
          >
            Delete my account
          </Button>
        )}
        {eraseState.phase === "confirming" && (
          <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="text-sm font-medium">
              Are you sure? This will permanently delete your account and all
              data. You will be signed out immediately.
            </p>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" onClick={handleErase}>
                Yes, delete my account
              </Button>
              <Button
                variant="outline"
                size="sm"
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
            Account deletion has been scheduled. Effective date:{" "}
            <span className="font-medium">
              {new Date(eraseState.effectiveAt).toLocaleDateString()}
            </span>
            . You will be signed out shortly.
          </p>
        )}
        {eraseState.phase === "error" && (
          <p className="text-sm text-destructive">{eraseState.message}</p>
        )}
      </section>
    </div>
  );
}
