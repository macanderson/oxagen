"use client";
// A control the design names whose write or page has no backing yet. It opens
// a sheet that says what the product would do and what is missing, so the
// person pressing it learns why nothing changed rather than meeting a button
// that silently does nothing (spec pages/agent.md, "Stub controls say what the
// product would do"). It never pretends to have acted.
import { useState } from "react";
import { buttonSecondary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";
import { buttonDanger } from "./parts";

export function StubAction({
  label,
  title,
  body,
  gap,
  testId,
  danger = false,
}: {
  /** The button's words, as the design names them. */
  label: string;
  /** The sheet's title. */
  title: string;
  /** What the product would do, then what Oxagen does not record yet. */
  body: string;
  /** The backend gap this waits on, carried as data for the audit. */
  gap: string;
  testId: string;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-stub={gap}
        className={danger ? buttonDanger : buttonSecondary}
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
        testId={`${testId}-sheet`}
      >
        <p className="text-sm text-muted-foreground" data-not-backed={gap}>
          {body}
        </p>
      </SheetDialog>
    </>
  );
}
