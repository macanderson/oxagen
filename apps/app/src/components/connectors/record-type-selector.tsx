"use client";

/**
 * record-type-selector.tsx — Multi-select checkboxes for connector record types.
 *
 * Shows displayName + description for each record type.
 * Respects defaultEnabled flag for initial state.
 * Stores selected record type IDs in formState under key "recordTypes".
 */

import * as React from "react";
import { CheckSquare, Square } from "lucide-react";
import { useConnectorSchema } from "./connector-schema-provider";
import { cn } from "@oxagen/ui";

const RECORD_TYPE_KEY = "recordTypes";

export function RecordTypeSelector() {
  const { schema, formState, setFieldValue } = useConnectorSchema();

  const recordTypes = schema?.recordTypes;

  // Initialize from formState or defaultEnabled
  // Hook must be called unconditionally — guard is applied after
  const selected: string[] = React.useMemo(() => {
    if (!recordTypes || recordTypes.items.length === 0) return [];
    const stored = formState.values[RECORD_TYPE_KEY];
    if (Array.isArray(stored)) return stored as string[];
    // Default: all defaultEnabled items
    return recordTypes.items
      .filter((rt) => rt.defaultEnabled)
      .map((rt) => rt.id);
  }, [formState.values, recordTypes]);

  if (!recordTypes || recordTypes.items.length === 0) return null;

  const toggle = (id: string) => {
    if (recordTypes.selectionMode === "single") {
      setFieldValue(RECORD_TYPE_KEY, [id]);
      return;
    }
    if (selected.includes(id)) {
      setFieldValue(
        RECORD_TYPE_KEY,
        selected.filter((s) => s !== id),
      );
    } else {
      setFieldValue(RECORD_TYPE_KEY, [...selected, id]);
    }
  };

  const allSelected = recordTypes.items.every((rt) => selected.includes(rt.id));
  const toggleAll = () => {
    if (allSelected) {
      setFieldValue(RECORD_TYPE_KEY, []);
    } else {
      setFieldValue(
        RECORD_TYPE_KEY,
        recordTypes.items.map((rt) => rt.id),
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">
          Record types to sync
        </p>
        {recordTypes.selectionMode === "multi" &&
          recordTypes.items.length > 2 && (
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-primary hover:underline"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          )}
      </div>

      <div
        className="flex flex-col gap-1.5"
        role="group"
        aria-label="Record types"
      >
        {recordTypes.items.map((rt) => {
          const checked = selected.includes(rt.id);
          return (
            <label
              key={rt.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
                checked
                  ? "border-primary/60 bg-primary/5"
                  : "border-border/60 hover:border-border hover:bg-muted/20",
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                onClick={() => toggle(rt.id)}
                className="mt-0.5 shrink-0 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
                aria-label={`${rt.displayName} ${checked ? "selected" : "not selected"}`}
              >
                {checked ? (
                  <CheckSquare className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Square
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </button>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-sm font-medium text-foreground">
                  {rt.displayName}
                </span>
                {rt.description && (
                  <span className="text-xs text-muted-foreground leading-relaxed">
                    {rt.description}
                  </span>
                )}
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}
