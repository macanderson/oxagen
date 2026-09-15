"use client";

/**
 * preview-step.tsx — Step 3 of the "Connect a source" wizard: sample records
 * fetched via connection.preview before any commitment, so bad credentials or
 * wrong scopes surface early (spec §Functionality "Step 3 — Preview",
 * §States "Error").
 *
 * Purely presentational — data fetching (the preview_connection call) lives
 * in the wizard orchestrator (connect-wizard.tsx) so this step stays easy to
 * unit test in isolation.
 */

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { Inbox } from "lucide-react";
import type { PreviewRecordType } from "./wizard-types";

export interface PreviewStepProps {
  loading: boolean;
  /** Raw connector error message from preview_connection — shown verbatim per spec. */
  error: string | null;
  recordTypes: PreviewRecordType[];
  onRetry: () => void;
  onNext: () => void;
  /**
   * Leaves the wizard back to Sources rather than "Back to Credentials" —
   * there is no connection.update capability in this wizard's allowed set,
   * so credentials entered in Step 2 cannot be safely re-edited once
   * create_connection has already run (the connection this step is
   * previewing). onCancel is expected to warn the caller that a pending
   * connection was created and will be left behind (see connect-wizard.tsx).
   */
  onCancel: () => void;
  submitting?: boolean;
}

function formatSampleValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string")
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (typeof value === "object") return JSON.stringify(value).slice(0, 60);
  return String(value);
}

export function PreviewStep({
  loading,
  error,
  recordTypes,
  onRetry,
  onNext,
  onCancel,
  submitting = false,
}: PreviewStepProps) {
  if (loading) {
    return (
      <div data-testid="preview-loading">
        <LoadingState variant="table" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Couldn't preview this connection"
        description={error}
        retry={onRetry}
      />
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {recordTypes.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No records found"
          description="This connection didn't return any sample records. You can still continue — mappings will be empty until data syncs in."
        />
      ) : (
        <div className="flex flex-col gap-4" data-testid="preview-record-types">
          {recordTypes.map((rt) => (
            <div
              key={rt.sourceRecordType}
              className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-4"
              data-testid={`preview-record-type-${rt.sourceRecordType}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {rt.displayName}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {rt.sampleCount} sample{rt.sampleCount === 1 ? "" : "s"}
                </Badge>
              </div>
              {rt.description && (
                <p className="text-xs text-muted-foreground">
                  {rt.description}
                </p>
              )}
              {rt.sampleRecords.length > 0 && (
                <div className="overflow-x-auto rounded-md border border-border/40">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-border/40 bg-muted/40">
                        {rt.sampleFields.map((field) => (
                          <th
                            key={field}
                            className="px-2.5 py-1.5 font-medium text-muted-foreground"
                          >
                            {field}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rt.sampleRecords.slice(0, 3).map((record, idx) => (
                        <tr
                          key={idx}
                          className="border-b border-border/20 last:border-b-0"
                        >
                          {rt.sampleFields.map((field) => (
                            <td
                              key={field}
                              className="px-2.5 py-1.5 text-foreground"
                            >
                              {formatSampleValue(
                                (record as Record<string, unknown>)[field],
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onNext}
          disabled={submitting}
          data-testid="preview-next-btn"
        >
          Next: Mappings
        </Button>
      </div>
    </div>
  );
}
