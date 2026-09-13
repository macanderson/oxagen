"use client";

/**
 * confirm-step.tsx — Step 5 of the "Connect a source" wizard: review + confirm.
 * set_connection_mappings persists the mapping and activates the connection,
 * kicking off async ingestion (spec §Functionality "Step 5 — Confirm").
 */

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MappingDraft } from "./wizard-types";

export interface ConfirmStepProps {
  connectorDisplayName: string;
  connectionDisplayName: string;
  mappings: MappingDraft[];
  submitting: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}

export function ConfirmStep({
  connectorDisplayName,
  connectionDisplayName,
  mappings,
  submitting,
  error,
  onConfirm,
  onBack,
}: ConfirmStepProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-foreground">
            {connectionDisplayName}
          </span>
          <Badge variant="outline" className="text-[10px]">
            {connectorDisplayName}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Confirming will save {mappings.length} entity-type mapping
          {mappings.length === 1 ? "" : "s"}, activate this connection, and
          start ingestion into the knowledge graph.
        </p>
      </div>

      <ul
        className="flex flex-col gap-1.5"
        data-testid="confirm-mapping-summary"
      >
        {mappings.map((m) => (
          <li
            key={m.sourceRecordType}
            className="flex items-center justify-between gap-2 rounded-md border border-border/40 px-3 py-2 text-xs"
          >
            <span className="text-muted-foreground">{m.sourceRecordType}</span>
            <span className="font-medium text-foreground">
              {m.oxagenEntityType}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onBack}
          disabled={submitting}
        >
          Back
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onConfirm}
          disabled={submitting}
          data-testid="confirm-activate-btn"
        >
          {submitting ? (
            <>
              <Loader2
                className="mr-2 h-3.5 w-3.5 animate-spin"
                aria-hidden="true"
              />
              Activating…
            </>
          ) : (
            <>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Connect &amp; activate
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
