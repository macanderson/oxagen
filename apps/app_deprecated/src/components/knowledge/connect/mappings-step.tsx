"use client";

/**
 * mappings-step.tsx — Step 4 of the "Connect a source" wizard: LLM-suggested
 * entity-type mappings (suggest_connection_mappings), rendered editable; the
 * user adjusts, then confirms (spec §Functionality "Step 4 — Mappings").
 *
 * Purely presentational — suggestion fetching lives in the wizard
 * orchestrator; this step only edits the draft array it's handed.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  LoadingState,
  ErrorState,
  EmptyState,
} from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { KeyValueEditor } from "@/components/connectors/key-value-editor";
import { Waypoints } from "lucide-react";
import type { MappingDraft } from "./wizard-types";

export interface MappingsStepProps {
  loading: boolean;
  error: string | null;
  drafts: MappingDraft[];
  onChangeDraft: (index: number, patch: Partial<MappingDraft>) => void;
  onRetry: () => void;
  onNext: () => void;
  onBack: () => void;
  submitting?: boolean;
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}% confidence`;
}

export function MappingsStep({
  loading,
  error,
  drafts,
  onChangeDraft,
  onRetry,
  onNext,
  onBack,
  submitting = false,
}: MappingsStepProps) {
  if (loading) {
    return (
      <div data-testid="mappings-loading">
        <LoadingState variant="cards" />
      </div>
    );
  }

  if (error) {
    return (
      <ErrorState
        title="Couldn't generate mapping suggestions"
        description={error}
        retry={onRetry}
      />
    );
  }

  if (drafts.length === 0) {
    return (
      <EmptyState
        icon={Waypoints}
        title="No mappings to review"
        description="No record types were previewed, so there are no entity-type mappings to suggest yet."
      />
    );
  }

  const hasEmptyEntityType = drafts.some((d) => !d.oxagenEntityType.trim());

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4" data-testid="mappings-list">
        {drafts.map((draft, idx) => (
          <div
            key={draft.sourceRecordType}
            className="flex flex-col gap-3 rounded-lg border border-border/60 bg-card p-4"
            data-testid={`mapping-row-${draft.sourceRecordType}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Source record type:{" "}
                <span className="font-medium text-foreground">
                  {draft.sourceRecordType}
                </span>
              </span>
              {typeof draft.confidence === "number" && (
                <Badge variant="outline" className="text-[10px]">
                  {confidenceLabel(draft.confidence)}
                </Badge>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`entity-type-${idx}`}>Entity type</Label>
              <Input
                id={`entity-type-${idx}`}
                value={draft.oxagenEntityType}
                onChange={(e) =>
                  onChangeDraft(idx, {
                    oxagenEntityType: e.currentTarget.value,
                  })
                }
                disabled={submitting}
                aria-invalid={!draft.oxagenEntityType.trim()}
              />
            </div>

            {draft.reasoning && (
              <p className="text-xs text-muted-foreground">{draft.reasoning}</p>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`property-mappings-${idx}`}>
                Property mappings
              </Label>
              <KeyValueEditor
                id={`property-mappings-${idx}`}
                value={draft.propertyMappings}
                onChange={(v) => onChangeDraft(idx, { propertyMappings: v })}
                keyPlaceholder="Source field"
                valuePlaceholder="Canonical property"
                disabled={submitting}
              />
            </div>
          </div>
        ))}
      </div>

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
          onClick={onNext}
          disabled={submitting || hasEmptyEntityType}
          data-testid="mappings-next-btn"
        >
          Next: Confirm
        </Button>
      </div>
    </div>
  );
}
