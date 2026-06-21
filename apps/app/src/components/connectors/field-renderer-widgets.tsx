"use client";

/**
 * field-renderer-widgets.tsx — Compound interactive widgets for the field renderer.
 *
 * TagInput:        chip/tag entry (comma or Enter separated)
 * MultiSelectWidget: toggle-button group for multi-select fields
 *
 * Both are self-contained stateful controls; they do not read from ConnectorSchemaContext
 * directly — the parent FieldRenderer handles context and passes values via props.
 */

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@oxagen/ui";
import type { TagInputProps, MultiSelectWidgetProps } from "./field-renderer-types";

// ── TagInput ──────────────────────────────────────────────────────────────────

export function TagInput({ id, value, onChange, onBlur, placeholder, disabled, itemPattern }: TagInputProps) {
  const [inputVal, setInputVal] = React.useState("");
  const [tagError, setTagError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addTag = React.useCallback(
    (raw: string) => {
      const tag = raw.trim();
      if (!tag) return;
      if (value.includes(tag)) {
        setTagError(`"${tag}" is already added`);
        return;
      }
      if (itemPattern) {
        const re = new RegExp(itemPattern);
        if (!re.test(tag)) {
          setTagError(`"${tag}" is not a valid format`);
          return;
        }
      }
      setTagError(null);
      onChange([...value, tag]);
      setInputVal("");
    },
    [value, onChange, itemPattern],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputVal);
    } else if (e.key === "Backspace" && !inputVal && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => {
    setTagError(null);
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div
      className="flex min-h-[2rem] flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground"
        >
          {tag}
          <button
            type="button"
            onClick={() => removeTag(tag)}
            disabled={disabled}
            className="rounded text-muted-foreground hover:text-destructive transition-colors disabled:opacity-40"
            aria-label={`Remove ${tag}`}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={inputVal}
        onChange={(e) => {
          setTagError(null);
          setInputVal(e.currentTarget.value);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (inputVal.trim()) addTag(inputVal);
          onBlur();
        }}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        className="flex-1 min-w-[100px] bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        aria-label="Add tag"
      />
      {tagError && (
        <p role="alert" className="w-full text-xs text-destructive mt-0.5">{tagError}</p>
      )}
    </div>
  );
}

// ── MultiSelectWidget ─────────────────────────────────────────────────────────

export function MultiSelectWidget({ id, value, onChange, onBlur, options, disabled }: MultiSelectWidgetProps) {
  const toggle = (opt: string) => {
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  };

  return (
    <div
      id={id}
      className="flex flex-wrap gap-1.5"
      role="group"
      onBlur={onBlur}
      tabIndex={-1}
    >
      {options.map((opt) => {
        const selected = value.includes(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => toggle(opt.value)}
            disabled={disabled}
            aria-pressed={selected}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              selected
                ? "border-primary bg-primary/10 text-primary"
                : "border-border/60 bg-transparent text-muted-foreground hover:border-border hover:text-foreground",
              "disabled:opacity-50 disabled:pointer-events-none",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
