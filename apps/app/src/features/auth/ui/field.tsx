"use client";
// A labelled input with its hint and error wired for assistive technology:
// the error is announced through aria-describedby and marks the input invalid.
import { Eye, EyeOff } from "lucide-react";
import { type InputHTMLAttributes, type ReactNode, useState } from "react";
import { inputBase } from "./styles";

export type FieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "name"
> & {
  id: string;
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Already-translated error text; renders under the input and marks it invalid. */
  error?: string | undefined;
  /** Rendered on the label row's far side (e.g. "Forgot password?"). */
  labelAside?: ReactNode;
  /** Rendered inside the input's box, on its trailing edge (e.g. a show/hide toggle). */
  trailing?: ReactNode;
};

export function Field({
  id,
  name,
  label,
  hint,
  error,
  labelAside,
  trailing,
  className,
  ...input
}: FieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {labelAside}
      </div>
      <div className="relative">
        <input
          id={id}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${inputBase} ${trailing ? "pr-20" : ""} ${className ?? ""}`}
          {...input}
        />
        {trailing ? (
          <div className="absolute inset-y-0 right-1.5 flex items-center">
            {trailing}
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type PasswordFieldProps = Omit<FieldProps, "type"> & {
  showLabel: string;
  hideLabel: string;
};

/** A password input with a show/hide toggle that keeps focus order and announces its state. */
export function PasswordField({
  showLabel,
  hideLabel,
  ...props
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <Field
      {...props}
      type={shown ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => {
            setShown((s) => !s);
          }}
          aria-pressed={shown}
          aria-controls={props.id}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {shown ? (
            <EyeOff aria-hidden className="size-3.5" />
          ) : (
            <Eye aria-hidden className="size-3.5" />
          )}
          {shown ? hideLabel : showLabel}
        </button>
      }
    />
  );
}
