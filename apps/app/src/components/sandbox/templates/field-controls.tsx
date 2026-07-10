"use client";

/**
 * field-controls.tsx — shared presentational primitives for the sandbox
 * template editor's grouped sections. Every field renders a label, an
 * optional one-line help string (the "what does this do / allowed range"
 * copy from manifest-field-meta.ts), and an optional inline validation error.
 */
import * as React from "react";
import { Input } from "@/components/ui/input";

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border/40 p-3"
      aria-label={title}
    >
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

export function Field({
  label,
  help,
  error,
  children,
}: {
  label: string;
  help?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error ? (
        <span className="text-xs text-destructive">{error}</span>
      ) : (
        help && <span className="text-xs text-muted-foreground">{help}</span>
      )}
    </label>
  );
}

export function NativeSelect({
  value,
  onChange,
  children,
  "data-testid": testId,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  return (
    <select
      className="max-md:h-11 rounded-md border border-border/50 bg-background px-2 py-1.5 text-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    >
      {children}
    </select>
  );
}

export function BoundedNumber({
  label,
  max,
  value,
  onChange,
  help,
}: {
  label: string;
  max: number;
  value: string;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={1}
        max={max}
        className="max-md:h-11"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && <span className="text-muted-foreground/80">{help}</span>}
    </label>
  );
}
