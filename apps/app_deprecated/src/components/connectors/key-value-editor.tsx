"use client";

/**
 * key-value-editor.tsx — Reusable inline key/value pair editor.
 *
 * Add/remove row buttons, edit key/value pairs inline.
 * Returns value as Record<string, string>.
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@oxagen/ui";

// ── Types ──────────────────────────────────────────────────────────────────────

interface KvRow {
  id: string;
  key: string;
  value: string;
}

export interface KeyValueEditorProps {
  value?: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowsToRecord(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.trim()) {
      out[row.key.trim()] = row.value;
    }
  }
  return out;
}

function recordToRows(record: Record<string, string> | undefined): KvRow[] {
  if (!record || Object.keys(record).length === 0) {
    return [{ id: crypto.randomUUID(), key: "", value: "" }];
  }
  return Object.entries(record).map(([k, v]) => ({
    id: crypto.randomUUID(),
    key: k,
    value: v,
  }));
}

// ── Component ─────────────────────────────────────────────────────────────────

export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
  disabled = false,
  className,
  id,
}: KeyValueEditorProps) {
  const [rows, setRows] = React.useState<KvRow[]>(() => recordToRows(value));

  // Sync external value → rows (only on first render / external reset)
  const prevValueRef = React.useRef(value);
  React.useEffect(() => {
    if (prevValueRef.current !== value) {
      prevValueRef.current = value;
      setRows(recordToRows(value));
    }
  }, [value]);

  const updateRow = React.useCallback(
    (id: string, field: "key" | "value", newVal: string) => {
      setRows((prev) => {
        const next = prev.map((r) =>
          r.id === id ? { ...r, [field]: newVal } : r,
        );
        onChange(rowsToRecord(next));
        return next;
      });
    },
    [onChange],
  );

  const addRow = React.useCallback(() => {
    setRows((prev) => [
      ...prev,
      { id: crypto.randomUUID(), key: "", value: "" },
    ]);
  }, []);

  const removeRow = React.useCallback(
    (id: string) => {
      setRows((prev) => {
        const next = prev.length > 1 ? prev.filter((r) => r.id !== id) : prev;
        onChange(rowsToRecord(next));
        return next;
      });
    },
    [onChange],
  );

  return (
    <div className={cn("flex flex-col gap-2", className)} id={id}>
      {rows.map((row, idx) => (
        <div key={row.id} className="flex items-center gap-2">
          <Input
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(e) => updateRow(row.id, "key", e.currentTarget.value)}
            disabled={disabled}
            aria-label={`Key ${idx + 1}`}
            className="flex-1"
          />
          <Input
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(e) => updateRow(row.id, "value", e.currentTarget.value)}
            disabled={disabled}
            aria-label={`Value ${idx + 1}`}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => removeRow(row.id)}
            disabled={disabled || rows.length === 1}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40 disabled:pointer-events-none"
            aria-label={`Remove row ${idx + 1}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        disabled={disabled}
        className="flex items-center gap-1.5 self-start rounded-md border border-dashed border-border/60 px-3 py-1.5 text-xs text-muted-foreground hover:border-border hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add row
      </button>
    </div>
  );
}
