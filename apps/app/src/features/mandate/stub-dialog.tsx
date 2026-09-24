"use client";
// A control the design draws whose write Oxagen does not have yet: Request
// access (the design's `request-access`) and Open an incident (`incident`).
//
// It is a real button that opens a real dialog, and the dialog says what the
// product would do and that nothing records it yet, then names the step a
// person can take today. A button that silently does nothing is worse than no
// button on a page about who may spend money, and a button that reported a
// write it did not make would be worse still.
import { useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";

export function StubDialog({
  label,
  title,
  body,
  gap,
  primary = false,
  testId,
}: {
  label: string;
  title: string;
  body: string;
  /** The backend gap the missing write belongs to. */
  gap: string;
  primary?: boolean;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={primary ? buttonPrimary : buttonSecondary}
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
        testId={testId}
      >
        <p
          data-state="not-backed"
          data-gap={gap}
          className="text-sm text-muted-foreground"
        >
          {body}
        </p>
      </SheetDialog>
    </>
  );
}
