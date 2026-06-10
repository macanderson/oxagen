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
 *
 * Validation: required, pattern, itemPattern, min/max, minItems/maxItems
 * Errors shown on blur + after form submit attempt.
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { X } from "lucide-react";
import { KeyValueEditor } from "./key-value-editor";
import { SecretFileUpload } from "./secret-file-upload";
import { useConnectorSchema } from "./connector-schema-provider";
import type { schemaFieldSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { z } from "zod";
import { cn } from "@oxagen/ui";

// ── Types ──────────────────────────────────────────────────────────────────────

type SchemaField = z.infer<typeof schemaFieldSchema>;

export interface FieldRendererProps {
  field: SchemaField;
  /** Namespace prefix for field ID (e.g. "config", "auth") */
  namespace?: string;
  disabled?: boolean;
}

// ── Validate helper ──────────────────────────────────────────────────────────

function validateField(
  field: SchemaField,
  value: unknown,
): string | null {
  const v = field.validation;
  if (!v) {
    if (field.validation?.required) {
      if (value === undefined || value === null || value === "") return "Required";
    }
    return null;
  }

  // Required
  if (v.required) {
    if (
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    ) {
      return "Required";
    }
  }

  // String validations
  if (typeof value === "string") {
    if (v.pattern) {
      const re = new RegExp(v.pattern);
      if (!re.test(value)) return `Invalid format`;
    }
  }

  // Number validations
  if (typeof value === "number") {
    if (v.min !== undefined && value < v.min) return `Minimum value is ${v.min}`;
    if (v.max !== undefined && value > v.max) return `Maximum value is ${v.max}`;
  }

  // Array validations
  if (Array.isArray(value)) {
    if (v.minItems !== undefined && value.length < v.minItems) {
      return `At least ${v.minItems} item${v.minItems !== 1 ? "s" : ""} required`;
    }
    if (v.maxItems !== undefined && value.length > v.maxItems) {
      return `At most ${v.maxItems} item${v.maxItems !== 1 ? "s" : ""} allowed`;
    }
    if (v.itemPattern) {
      const re = new RegExp(v.itemPattern);
      const invalid = (value as string[]).find((item) => !re.test(item));
      if (invalid) return `"${invalid}" is not a valid format`;
    }
  }

  return null;
}

// ── Field wrapper with label + error ─────────────────────────────────────────

interface FieldWrapperProps {
  id: string;
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  /** Switch fields render label inline (right of toggle) */
  inline?: boolean;
}

function FieldWrapper({
  id,
  label,
  description,
  error,
  required,
  children,
  inline = false,
}: FieldWrapperProps) {
  if (inline) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          {children}
          <Label htmlFor={id} className="cursor-pointer select-none">
            {label}
            {required && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
          </Label>
        </div>
        {description && !error && (
          <p className="text-xs text-muted-foreground pl-[52px]">{description}</p>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive pl-[52px]">{error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && <span className="ml-0.5 text-destructive" aria-hidden="true">*</span>}
      </Label>
      {children}
      {description && !error && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

// ── Tag input widget ──────────────────────────────────────────────────────────

interface TagInputProps {
  id: string;
  value: string[];
  onChange: (tags: string[]) => void;
  onBlur: () => void;
  placeholder?: string;
  disabled?: boolean;
  itemPattern?: string;
}

function TagInput({ id, value, onChange, onBlur, placeholder, disabled, itemPattern }: TagInputProps) {
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

// ── MultiSelect widget ────────────────────────────────────────────────────────

interface MultiSelectWidgetProps {
  id: string;
  value: string[];
  onChange: (v: string[]) => void;
  onBlur: () => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}

function MultiSelectWidget({ id, value, onChange, onBlur, options, disabled }: MultiSelectWidgetProps) {
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
          aria-describedby={showError ? `${fieldId}-error` : undefined}
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
        />
      </FieldWrapper>
    );
  }

  // ── textarea ─────────────────────────────────────────────────────────────────
  if (widget === "textarea") {
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
          className="resize-y min-h-[80px]"
          aria-invalid={Boolean(showError)}
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
          <SelectTrigger id={fieldId} aria-invalid={Boolean(showError)}>
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
      />
    </FieldWrapper>
  );
}

// Export validate helper for use in form submission
export { validateField };
