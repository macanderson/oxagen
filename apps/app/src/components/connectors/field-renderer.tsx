"use client";

/**
 * field-renderer.tsx — Decision tree that maps ConnectorPluginSchema field widgets
 * to concrete React form controls.
 *
 * Widget coverage:
 *   text, email, url      → Input (type matching)
 *   secret                → Input type=password (masked)
 *   number                → Input type=number
 *   textarea              → Textarea (auto-grow via resize-y)
 *   select                → Select (single value)
 *   multi-select          → Combobox multi (free-toggle list)
 *   tag-input             → Tag/chip input (comma/Enter separated)
 *   checkbox              → Switch
 *   slider                → Slider with live value display
 *   key-value             → KeyValueEditor
 *   secret-file           → SecretFileUpload
 *   code                  → Textarea (monospace); with `format: json` a
 *                           JsonCodeField that stores the PARSED value
 *
 * Validation: required, pattern, itemPattern, min/max, minItems/maxItems
 * Errors shown on blur + after form submit attempt.
 *
 * Modules:
 *   field-renderer-types.ts     — shared TypeScript interfaces/types
 *   field-renderer-helpers.ts   — validateField (pure, no React)
 *   field-wrapper.tsx           — FieldWrapper layout component
 *   field-renderer-widgets.tsx  — TagInput, MultiSelectWidget, JsonCodeField
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { KeyValueEditor } from "./key-value-editor";
import { SecretFileUpload } from "./secret-file-upload";
import { useConnectorSchema } from "./connector-schema-provider";
import { FieldWrapper } from "./field-wrapper";
import { TagInput, MultiSelectWidget, JsonCodeField } from "./field-renderer-widgets";
import { validateField } from "./field-renderer-helpers";
import type { FieldRendererProps } from "./field-renderer-types";

export type { FieldRendererProps };
export { validateField };

// ── Main FieldRenderer ─────────────────────────────────────────────────────────

export function FieldRenderer({ field, namespace = "config", disabled = false }: FieldRendererProps) {
  const { formState, setFieldValue, touchField, isFieldVisible } = useConnectorSchema();

  const fieldId = `${namespace}.${field.key}`;
  const rawValue = formState.values[field.key];
  const isVisible = isFieldVisible(field.key, field.dependsOn);

  // Find error for this field (keyed by full path or short key)
  const fieldError = formState.errors.find(
    (e) => e.field === fieldId || e.field === field.key,
  );
  // Only show error if field has been touched OR there are server-side errors
  const showError =
    fieldError &&
    (formState.touched.has(field.key) || fieldError.code !== undefined);

  const handleBlur = React.useCallback(() => {
    touchField(field.key);
    // Client-side validation on blur
    const err = validateField(field, rawValue);
    if (err) {
      // We don't set errors here — parent form submit does full validation.
      // Touch is enough to show server errors.
    }
  }, [field, rawValue, touchField]);

  if (!isVisible) return null;

  const { widget } = field;
  const required = field.validation?.required ?? false;

  // aria-describedby: FieldWrapper renders exactly one of these at a time —
  // the error paragraph (id="${fieldId}-error") when there is an error to show,
  // or the description paragraph (id="${fieldId}-description") when there is a
  // description and no error. Only reference the id that is actually rendered.
  const ariaDescribedBy = showError
    ? `${fieldId}-error`
    : field.description
      ? `${fieldId}-description`
      : undefined;

  // ── text / email / url ──────────────────────────────────────────────────────
  if (widget === "text" || widget === "email" || widget === "url") {
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <Input
          id={fieldId}
          type={widget}
          value={typeof rawValue === "string" ? rawValue : ""}
          onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
          onBlur={handleBlur}
          placeholder={field.placeholder}
          disabled={disabled}
          aria-invalid={Boolean(showError)}
          aria-describedby={ariaDescribedBy}
        />
      </FieldWrapper>
    );
  }

  // ── secret ──────────────────────────────────────────────────────────────────
  if (widget === "secret") {
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <Input
          id={fieldId}
          type="password"
          autoComplete="new-password"
          value={typeof rawValue === "string" ? rawValue : ""}
          onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
          onBlur={handleBlur}
          placeholder={field.placeholder ?? "••••••••"}
          disabled={disabled}
          aria-invalid={Boolean(showError)}
          aria-describedby={ariaDescribedBy}
        />
      </FieldWrapper>
    );
  }

  // ── number ──────────────────────────────────────────────────────────────────
  if (widget === "number") {
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <Input
          id={fieldId}
          type="number"
          value={typeof rawValue === "number" ? String(rawValue) : (rawValue as string | undefined) ?? ""}
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            setFieldValue(field.key, isNaN(n) ? undefined : n);
          }}
          onBlur={handleBlur}
          placeholder={field.placeholder}
          min={field.validation?.min}
          max={field.validation?.max}
          disabled={disabled}
          aria-invalid={Boolean(showError)}
          aria-describedby={ariaDescribedBy}
        />
      </FieldWrapper>
    );
  }

  // ── textarea / code ──────────────────────────────────────────────────────────
  // "code" is a multi-line monospace variant used for SQL / JSON / payload
  // config (custom-sql, custom-webhook, google-bigquery). It shares the textarea
  // input surface but renders larger with a monospace font.
  if (widget === "textarea" || widget === "code") {
    const isCode = widget === "code";
    // A `code` field declaring `format: json` holds structured config, not
    // text: its connector's connection schema expects the parsed value
    // (custom-webhook's recordTypes and custom-sql's queries are both arrays).
    // google-bigquery's `query` is SQL and carries no format, so it stays a
    // plain string on this same widget.
    if (isCode && field.format === "json") {
      return (
        <FieldWrapper
          id={fieldId}
          label={field.label}
          description={field.description}
          error={showError ? fieldError.message : undefined}
          required={required}
        >
          <JsonCodeField
            id={fieldId}
            value={rawValue}
            onChange={(parsed) => setFieldValue(field.key, parsed)}
            onBlur={handleBlur}
            placeholder={field.placeholder}
            disabled={disabled}
            invalid={Boolean(showError)}
            ariaDescribedBy={ariaDescribedBy}
          />
        </FieldWrapper>
      );
    }
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <Textarea
          id={fieldId}
          value={typeof rawValue === "string" ? rawValue : ""}
          onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
          onBlur={handleBlur}
          placeholder={field.placeholder}
          disabled={disabled}
          className={
            isCode
              ? "resize-y min-h-[140px] font-mono text-xs"
              : "resize-y min-h-[80px]"
          }
          spellCheck={isCode ? false : undefined}
          aria-invalid={Boolean(showError)}
          aria-describedby={ariaDescribedBy}
        />
      </FieldWrapper>
    );
  }

  // ── select ───────────────────────────────────────────────────────────────────
  if (widget === "select") {
    const options = field.options ?? [];
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <Select
          value={typeof rawValue === "string" ? rawValue : undefined}
          onValueChange={(v) => {
            setFieldValue(field.key, v);
            touchField(field.key);
          }}
          disabled={disabled}
          name={fieldId}
        >
          <SelectTrigger
            id={fieldId}
            aria-invalid={Boolean(showError)}
            aria-describedby={ariaDescribedBy}
          >
            <SelectValue placeholder={field.placeholder ?? "Select…"} />
          </SelectTrigger>
          <SelectPopup>
            {options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </FieldWrapper>
    );
  }

  // ── multi-select ─────────────────────────────────────────────────────────────
  if (widget === "multi-select") {
    const options = field.options ?? [];
    const current = Array.isArray(rawValue) ? (rawValue as string[]) : [];
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <MultiSelectWidget
          id={fieldId}
          value={current}
          onChange={(v) => setFieldValue(field.key, v)}
          onBlur={handleBlur}
          options={options}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // ── tag-input ─────────────────────────────────────────────────────────────────
  if (widget === "tag-input") {
    const current = Array.isArray(rawValue) ? (rawValue as string[]) : [];
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <TagInput
          id={fieldId}
          value={current}
          onChange={(v) => setFieldValue(field.key, v)}
          onBlur={handleBlur}
          placeholder={field.placeholder ?? "Type and press Enter…"}
          disabled={disabled}
          itemPattern={field.validation?.itemPattern}
        />
      </FieldWrapper>
    );
  }

  // ── checkbox (Switch) ─────────────────────────────────────────────────────────
  if (widget === "checkbox") {
    const checked = typeof rawValue === "boolean" ? rawValue : Boolean(field.defaultValue);
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
        inline
      >
        <Switch
          id={fieldId}
          checked={checked}
          onCheckedChange={(v) => {
            setFieldValue(field.key, v);
            touchField(field.key);
          }}
          disabled={disabled}
          aria-invalid={Boolean(showError)}
          aria-describedby={ariaDescribedBy}
        />
      </FieldWrapper>
    );
  }

  // ── slider ─────────────────────────────────────────────────────────────────────
  if (widget === "slider") {
    const numVal = typeof rawValue === "number" ? rawValue : (field.defaultValue as number | undefined) ?? (field.validation?.min ?? 0);
    const min = field.validation?.min ?? 0;
    const max = field.validation?.max ?? 100;
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <div className="flex items-center gap-3">
          <Slider
            id={fieldId}
            value={numVal}
            onValueChange={(v) => setFieldValue(field.key, v)}
            onValueCommitted={() => touchField(field.key)}
            min={min}
            max={max}
            step={field.validation?.min !== undefined && field.validation.max !== undefined
              ? Math.round((max - min) / 100 * 10) / 10 || 0.01
              : 1}
            disabled={disabled}
            className="flex-1"
            aria-describedby={ariaDescribedBy}
          />
          <span className="min-w-[3rem] text-right text-sm tabular-nums text-foreground">
            {typeof numVal === "number" ? numVal : "—"}
          </span>
        </div>
      </FieldWrapper>
    );
  }

  // ── key-value ──────────────────────────────────────────────────────────────────
  if (widget === "key-value") {
    const current = (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue))
      ? (rawValue as Record<string, string>)
      : {};
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <KeyValueEditor
          id={fieldId}
          value={current}
          onChange={(v) => setFieldValue(field.key, v)}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // ── secret-file ────────────────────────────────────────────────────────────────
  if (widget === "secret-file") {
    return (
      <FieldWrapper
        id={fieldId}
        label={field.label}
        description={field.description}
        error={showError ? fieldError.message : undefined}
        required={required}
      >
        <SecretFileUpload
          id={fieldId}
          value={typeof rawValue === "string" ? rawValue : undefined}
          onChange={(v) => {
            setFieldValue(field.key, v);
            touchField(field.key);
          }}
          disabled={disabled}
        />
      </FieldWrapper>
    );
  }

  // Fallback for unknown widget types — render as text input
  return (
    <FieldWrapper
      id={fieldId}
      label={field.label}
      description={field.description}
      error={showError ? fieldError.message : undefined}
      required={required}
    >
      <Input
        id={fieldId}
        type="text"
        value={typeof rawValue === "string" ? rawValue : ""}
        onChange={(e) => setFieldValue(field.key, e.currentTarget.value)}
        onBlur={handleBlur}
        disabled={disabled}
        aria-describedby={ariaDescribedBy}
      />
    </FieldWrapper>
  );
}
