"use client";

/**
 * field-wrapper.tsx — Label + description/error layout shell for connector form fields.
 *
 * Renders in two layouts:
 *   - default: label above, description/error below the control
 *   - inline:  control left, label right (used by checkbox/Switch)
 *
 * The description paragraph carries id="${id}-description" and the error paragraph
 * carries id="${id}-error". Exactly one is rendered at a time so that the control's
 * aria-describedby can safely reference only the id that is present in the DOM.
 */

import * as React from "react";
import { Label } from "@/components/ui/label";
import type { FieldWrapperProps } from "./field-renderer-types";

export function FieldWrapper({
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
            {required && (
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
            )}
          </Label>
        </div>
        {description && !error && (
          <p
            id={`${id}-description`}
            className="text-xs text-muted-foreground pl-[52px]"
          >
            {description}
          </p>
        )}
        {error && (
          <p
            id={`${id}-error`}
            role="alert"
            className="text-xs text-destructive pl-[52px]"
          >
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {description && !error && (
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {description}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
