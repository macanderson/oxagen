"use client";
// A single choice drawn as a row of option cards: the harness, runtime and
// toolbelt pickers of the register flow and the agent page (ADR-192).
//
// A native <select> cannot say why an option is off, and a disabled control
// cannot be hovered or focused, so an option that is taken stays in the row,
// focusable and hoverable, with `aria-disabled` and its reason. Hovering or
// focusing it opens the reason as a popover beside it; a screen reader hears
// the reason as the option's description whether or not the popover is open.
// Choosing a taken option does nothing.
import { type ReactNode, useId, useState } from "react";

type ChoiceOption<V extends string> = {
  value: V;
  label: ReactNode;
  /** A second line under the label. */
  sub?: ReactNode;
  /** Why the option cannot be chosen; null or absent when it can. */
  disabledReason?: string | null;
};

function Option<V extends string>({
  option,
  checked,
  onChoose,
  testId,
}: {
  option: ChoiceOption<V>;
  checked: boolean;
  onChoose: (value: V) => void;
  testId: string;
}) {
  const reasonId = useId();
  const [open, setOpen] = useState(false);
  const reason = option.disabledReason ?? null;
  const disabled = reason !== null;
  return (
    <span className="relative flex min-w-0">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        data-testid={testId}
        data-value={option.value}
        data-touch-target=""
        onClick={() => {
          if (!disabled) onChoose(option.value);
        }}
        onMouseEnter={() => {
          if (disabled) setOpen(true);
        }}
        onMouseLeave={() => {
          setOpen(false);
        }}
        onFocus={() => {
          if (disabled) setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        className={[
          "flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-ring",
          checked
            ? "border-gold bg-hl text-foreground"
            : "border-border bg-app-panel-bg text-foreground",
          disabled
            ? "cursor-not-allowed text-muted-foreground opacity-70"
            : "hover:border-rule",
        ].join(" ")}
      >
        <span className="font-medium">{option.label}</span>
        {option.sub === undefined ? null : (
          <span className="text-xs text-muted-foreground">{option.sub}</span>
        )}
      </button>
      {disabled ? (
        <span
          id={reasonId}
          role="tooltip"
          data-testid={`${testId}-reason`}
          data-open={open ? "" : undefined}
          className={
            open
              ? "absolute left-0 top-full z-20 mt-1.5 w-max max-w-72 rounded-md border border-border bg-app-raised-bg px-2.5 py-1.5 text-xs text-app-raised-fg shadow-md"
              : "sr-only"
          }
        >
          {reason}
        </span>
      ) : null}
    </span>
  );
}

export function ChoiceGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  testId,
  describedBy,
}: {
  /** The group's accessible name, which the visible label above it carries. */
  label: string;
  options: readonly ChoiceOption<V>[];
  /** The chosen value, or null before a choice. */
  value: V | null;
  onChange: (value: V) => void;
  testId: string;
  /** Ids of a hint or an error under the group. */
  describedBy?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      className="grid min-w-0 gap-2 sm:grid-cols-2"
    >
      {options.map((option) => (
        <Option
          key={option.value}
          option={option}
          checked={option.value === value}
          onChoose={onChange}
          testId={`${testId}-option`}
        />
      ))}
    </div>
  );
}
