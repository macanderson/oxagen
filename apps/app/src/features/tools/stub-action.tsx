"use client";
// A control whose write has no store behind it yet (mockup `tools.md`: "Stub
// controls say what the product would do; nothing silently does nothing").
// The button opens the dialog the design names, the dialog shows what the
// action would take and says, in one sentence, what it would do and that the
// record does not hold it yet. Its confirming button is disabled and points at
// that sentence, so nobody is told a change happened when none did.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { buttonDanger, buttonGhost } from "./buttons";
import { gapRef, type ToolsGap } from "./gaps";

const TRIGGER = {
  primary: buttonPrimary,
  secondary: buttonSecondary,
  danger: buttonDanger,
  ghost: buttonGhost,
} as const;

export function StubAction({
  label,
  tone = "secondary",
  title,
  subtitle,
  gap,
  note,
  confirm,
  testId,
  wide = false,
  children,
}: {
  /** The trigger's words, as the design writes them. */
  label: ReactNode;
  tone?: keyof typeof TRIGGER;
  title: string;
  subtitle?: string;
  gap: ToolsGap;
  /** What the action would do, and that nothing records it yet. */
  note: string;
  /** The confirming button's words, drawn disabled. */
  confirm: string;
  testId: string;
  wide?: boolean;
  /** What the dialog would ask for or show, drawn read-only. */
  children?: ReactNode;
}) {
  const t = useTranslations("tools");
  const [open, setOpen] = useState(false);
  const noteId = useId();
  return (
    <>
      <button
        type="button"
        data-testid={`${testId}-open`}
        className={TRIGGER[tone]}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        subtitle={subtitle}
        wide={wide}
        testId={testId}
        footer={
          <button
            type="button"
            disabled
            aria-describedby={noteId}
            data-testid={`${testId}-confirm`}
            className={buttonPrimary}
          >
            {confirm}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          {children}
          <p
            id={noteId}
            data-state="not-backed"
            data-gap={gapRef(gap)}
            className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[13px] text-muted-foreground"
          >
            <span className="mb-0.5 block text-[10.5px] font-semibold uppercase tracking-[0.1em] text-dim">
              {t("notBacked")}
            </span>
            {note}
          </p>
        </div>
      </SheetDialog>
    </>
  );
}

/**
 * One field the stubbed dialog would ask for, drawn disabled so it cannot be
 * mistaken for a form that saves. `options` draws a select, which is how the
 * design offers a fixed set (a transport, a wire, an owning team).
 */
export function StubField({
  id,
  label,
  hint,
  options,
  placeholder,
}: {
  id: string;
  label: string;
  hint?: string;
  options?: readonly string[];
  placeholder?: string;
}) {
  const field =
    "block w-full min-w-0 rounded-md border border-input-border bg-input-disabled-bg px-3 py-2 text-base text-input-disabled-fg md:text-[13px]";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {options === undefined ? (
        <input id={id} disabled placeholder={placeholder} className={field} />
      ) : (
        <select id={id} disabled className={field}>
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      )}
      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
