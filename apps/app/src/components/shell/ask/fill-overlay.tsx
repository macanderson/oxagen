"use client";
/**
 * FillOverlay — renders the FieldDiff[] returned by fillFormAction over/beside
 * the registered form.
 *
 * Layout: a fixed right-anchored panel (Sheet-like) that lists every changed
 * field with:
 *   - Current value (struck through)
 *   - Proposed value (accent-highlighted)
 *   - Optional AI rationale
 *   - Per-field Accept (check) and Reject (×) buttons
 *
 * Top-level controls:
 *   - "Apply all" — calls form.apply(allProposedValues, "all")
 *   - "Reject all" — clears fillResult from context
 *
 * On per-field accept: calls form.apply({ [name]: proposed }, "field", name)
 *   and wraps the field in FieldFillTransition active=true briefly.
 *
 * Accessibility:
 *   - Announced via role="status" region when changes arrive
 *   - All interactive controls have visible focus rings
 *   - prefers-reduced-motion respected via FieldFillTransition
 */

import * as React from "react";
import { Check, X, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePageContext } from "@/lib/page-context";
import { FieldFillTransition } from "@/components/ui/field-fill-transition";
import type { FieldDiff } from "@/lib/ask/fill-types";

export function FillOverlay() {
  const { fillResult, fillableForm, _setFillResult, isFilling } =
    usePageContext();

  // An incrementing key drives a full remount of the inner panel whenever a
  // new fillResult arrives, resetting all per-field state in one React
  // reconcile pass — no setState inside an effect, no ref access during render.
  const [panelKey, setPanelKey] = React.useState(0);
  const prevFillResultRef = React.useRef(fillResult);
  React.useEffect(() => {
    if (fillResult !== null && fillResult !== prevFillResultRef.current) {
      setPanelKey((k) => k + 1);
    }
    prevFillResultRef.current = fillResult;
  }, [fillResult]);

  return (
    <FillOverlayPanel
      key={panelKey}
      fillResult={fillResult}
      fillableForm={fillableForm}
      isFilling={isFilling}
      _setFillResult={_setFillResult}
    />
  );
}

// ---------------------------------------------------------------------------
// Inner panel — key-reset by parent resets all per-field state automatically.
// ---------------------------------------------------------------------------

interface FillOverlayPanelProps {
  fillResult: ReturnType<typeof usePageContext>["fillResult"];
  fillableForm: ReturnType<typeof usePageContext>["fillableForm"];
  isFilling: boolean;
  _setFillResult: ReturnType<typeof usePageContext>["_setFillResult"];
}

function FillOverlayPanel({
  fillResult,
  fillableForm,
  isFilling,
  _setFillResult,
}: FillOverlayPanelProps) {
  // Track which fields have been individually accepted (for transition feedback).
  const [acceptedFields, setAcceptedFields] = React.useState<Set<string>>(
    new Set(),
  );
  // Track which fields have been individually rejected.
  const [rejectedFields, setRejectedFields] = React.useState<Set<string>>(
    new Set(),
  );
  // Expanded rationale per field.
  const [expandedRationale, setExpandedRationale] = React.useState<Set<string>>(
    new Set(),
  );

  // Dismiss when all fields are resolved.
  const changedFields = React.useMemo(
    () => (fillResult?.fields ?? []).filter((f) => f.changed),
    [fillResult],
  );
  const pendingFields = changedFields.filter(
    (f) => !acceptedFields.has(f.name) && !rejectedFields.has(f.name),
  );

  React.useEffect(() => {
    if (fillResult && changedFields.length > 0 && pendingFields.length === 0) {
      // All resolved — auto-dismiss after a brief pause.
      const timer = setTimeout(() => _setFillResult(null), 600);
      return () => clearTimeout(timer);
    }
  }, [fillResult, changedFields.length, pendingFields.length, _setFillResult]);

  const handleAcceptField = React.useCallback(
    (diff: FieldDiff) => {
      if (!fillableForm) return;
      fillableForm.apply({ [diff.name]: diff.proposed }, "field", diff.name);
      setAcceptedFields((prev) => new Set(prev).add(diff.name));
    },
    [fillableForm],
  );

  const handleRejectField = React.useCallback((name: string) => {
    setRejectedFields((prev) => new Set(prev).add(name));
  }, []);

  const handleApplyAll = React.useCallback(() => {
    if (!fillableForm || !fillResult) return;
    const values = Object.fromEntries(
      changedFields
        .filter((f) => !rejectedFields.has(f.name))
        .map((f) => [f.name, f.proposed]),
    );
    fillableForm.apply(values, "all");
    setAcceptedFields(new Set(changedFields.map((f) => f.name)));
    _setFillResult(null);
  }, [fillableForm, fillResult, changedFields, rejectedFields, _setFillResult]);

  const handleRejectAll = React.useCallback(() => {
    _setFillResult(null);
    setAcceptedFields(new Set());
    setRejectedFields(new Set());
  }, [_setFillResult]);

  const toggleRationale = React.useCallback((name: string) => {
    setExpandedRationale((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  // Nothing to show.
  if (!isFilling && (!fillResult || changedFields.length === 0)) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label="AI fill suggestions"
      className={cn(
        // Fixed panel — right-aligned, above other content
        "fixed bottom-6 right-6 z-50",
        "w-full max-w-sm",
        // Stock card surface
        "overflow-hidden rounded-xl border bg-card text-card-foreground shadow-lg",
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-foreground" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">
            {isFilling
              ? "Filling form…"
              : `${changedFields.length} suggestion${changedFields.length !== 1 ? "s" : ""}`}
          </span>
        </div>
        {!isFilling && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleApplyAll}
              aria-label="Apply all suggestions"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1",
                "text-xs font-medium text-foreground",
                "transition-colors hover:bg-accent",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Apply all
            </button>
            <button
              type="button"
              onClick={handleRejectAll}
              aria-label="Reject all suggestions"
              className={cn(
                "inline-flex items-center gap-1 rounded-lg px-2 py-1",
                "text-xs font-medium text-muted-foreground",
                "transition-colors hover:bg-muted/60 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Reject all
            </button>
          </div>
        )}
      </div>

      {/* Loading state */}
      {isFilling && (
        <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <div
            className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-accent"
            aria-hidden="true"
          />
          Generating suggestions…
        </div>
      )}

      {/* Field diffs */}
      {!isFilling && (
        <div className="max-h-[60vh] overflow-y-auto">
          {changedFields.map((diff) => {
            const isAccepted = acceptedFields.has(diff.name);
            const isRejected = rejectedFields.has(diff.name);
            const isRationaleOpen = expandedRationale.has(diff.name);
            const isPending = !isAccepted && !isRejected;

            return (
              <FieldFillTransition key={diff.name} active={isAccepted}>
                <div
                  className={cn(
                    "border-b border-border/20 px-4 py-3 last:border-b-0",
                    "transition-opacity duration-300",
                    (isAccepted || isRejected) && "opacity-50",
                  )}
                >
                  {/* Field name */}
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {diff.name}
                    </span>
                    {/* Per-field actions — only when pending */}
                    {isPending && (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleAcceptField(diff)}
                          aria-label={`Accept suggestion for ${diff.name}`}
                          className={cn(
                            "flex h-5 w-5 items-center justify-center rounded-full",
                            "bg-primary text-primary-foreground",
                            "transition-colors hover:bg-primary/90",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectField(diff.name)}
                          aria-label={`Reject suggestion for ${diff.name}`}
                          className={cn(
                            "flex h-5 w-5 items-center justify-center rounded-full",
                            "bg-muted/60 text-muted-foreground",
                            "transition-colors hover:bg-muted hover:text-foreground",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    {/* Accepted / rejected badge */}
                    {isAccepted && (
                      <span className="text-[10px] font-medium text-foreground">
                        Applied
                      </span>
                    )}
                    {isRejected && (
                      <span className="text-[10px] font-medium text-muted-foreground">
                        Skipped
                      </span>
                    )}
                  </div>

                  {/* Value diff: current → proposed */}
                  <div className="flex flex-col gap-1 text-xs">
                    {/* Current value */}
                    <div className="flex items-start gap-1.5">
                      <span className="mt-0.5 shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground/50 w-14">
                        Current
                      </span>
                      <span
                        className={cn(
                          "break-words text-muted-foreground/70",
                          isPending &&
                            "line-through decoration-muted-foreground/40",
                        )}
                      >
                        {formatFieldValue(diff.current)}
                      </span>
                    </div>

                    {/* Proposed value */}
                    {isPending && (
                      <div className="flex items-start gap-1.5">
                        <span className="mt-0.5 w-14 shrink-0 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Proposed
                        </span>
                        <span className="break-words font-medium text-foreground">
                          {formatFieldValue(diff.proposed)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Rationale toggle */}
                  {diff.reason && isPending && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => toggleRationale(diff.name)}
                        aria-expanded={isRationaleOpen}
                        aria-label={
                          isRationaleOpen ? "Hide reasoning" : "Show reasoning"
                        }
                        className={cn(
                          "flex items-center gap-1 text-[10px] text-muted-foreground/50",
                          "transition-colors hover:text-muted-foreground",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
                        )}
                      >
                        {isRationaleOpen ? (
                          <ChevronUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ChevronDown className="h-3 w-3" aria-hidden="true" />
                        )}
                        Why this change?
                      </button>
                      {isRationaleOpen && (
                        <p className="mt-1 text-[10px] text-muted-foreground/70 leading-relaxed">
                          {diff.reason}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </FieldFillTransition>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format an unknown field value for display in the diff overlay. */
function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  // Object/array — compact JSON
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
