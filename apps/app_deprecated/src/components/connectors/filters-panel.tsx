"use client";

/**
 * filters-panel.tsx — Path and label filter configuration UI.
 *
 * pathFilters: textarea for glob patterns (one per line)
 * labelFilters: tag input for include/exclude label filters
 * Shows defaults from schema if provided.
 */

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import { useConnectorSchema } from "./connector-schema-provider";

const PATH_FILTERS_KEY = "pathFilters";
const LABEL_FILTERS_KEY = "labelFilters";

// ── Label tag input ────────────────────────────────────────────────────────────

interface LabelTagInputProps {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}

function LabelTagInput({
  id,
  value,
  onChange,
  placeholder,
}: LabelTagInputProps) {
  const [inputVal, setInputVal] = React.useState("");

  const addTag = (raw: string) => {
    const tag = raw.trim();
    if (!tag || value.includes(tag)) {
      setInputVal("");
      return;
    }
    onChange([...value, tag]);
    setInputVal("");
  };

  return (
    <div className="flex min-h-[2rem] flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
      {value.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="rounded text-muted-foreground hover:text-destructive transition-colors"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={inputVal}
        onChange={(e) => setInputVal(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(inputVal);
          } else if (e.key === "Backspace" && !inputVal && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (inputVal.trim()) addTag(inputVal);
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[100px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        aria-label="Add label filter"
      />
    </div>
  );
}

// ── FiltersPanel ──────────────────────────────────────────────────────────────

export function FiltersPanel() {
  const { schema, formState, setFieldValue } = useConnectorSchema();

  const filters = schema?.filters;
  if (!filters) return null;

  const showPath = filters.pathFilters?.enabled === true;
  const showLabel = filters.labelFilters?.enabled === true;

  if (!showPath && !showLabel) return null;

  // Path filters stored as newline-separated string in form values
  const pathFilterLines: string =
    typeof formState.values[PATH_FILTERS_KEY] === "string"
      ? (formState.values[PATH_FILTERS_KEY] as string)
      : (filters.pathFilters?.defaultIgnore ?? []).join("\n");

  const labelFilters: string[] = Array.isArray(
    formState.values[LABEL_FILTERS_KEY],
  )
    ? (formState.values[LABEL_FILTERS_KEY] as string[])
    : [];

  return (
    <div className="flex flex-col gap-5">
      {showPath && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`filter-paths`}>Path ignore patterns</Label>
          <Textarea
            id="filter-paths"
            value={pathFilterLines}
            onChange={(e) =>
              setFieldValue(PATH_FILTERS_KEY, e.currentTarget.value)
            }
            placeholder={"node_modules/**\ndist/**\n*.lock"}
            className="resize-y min-h-[80px] font-mono text-xs"
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            One glob pattern per line. Matching paths will be excluded from
            sync.
            {filters.pathFilters?.appliesTo &&
              filters.pathFilters.appliesTo.length > 0 && (
                <> Applies to: {filters.pathFilters.appliesTo.join(", ")}.</>
              )}
          </p>
        </div>
      )}

      {showLabel && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="filter-labels">Label filters</Label>
          <LabelTagInput
            id="filter-labels"
            value={labelFilters}
            onChange={(v) => setFieldValue(LABEL_FILTERS_KEY, v)}
            placeholder="Type a label and press Enter…"
          />
          <p className="text-xs text-muted-foreground">
            Only sync items with these labels. Leave empty to sync all.
            {filters.labelFilters?.appliesTo &&
              filters.labelFilters.appliesTo.length > 0 && (
                <> Applies to: {filters.labelFilters.appliesTo.join(", ")}.</>
              )}
          </p>
        </div>
      )}
    </div>
  );
}
