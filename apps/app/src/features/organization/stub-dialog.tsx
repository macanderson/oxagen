"use client";
// Two read-only dialogs the Organization tabs open from a button.
//
// `DetailsDialog` shows what a row already carries, rendered by the server
// section and handed in as children (a member's facts).
//
// `StubDialog` is a control the design draws whose write no capability
// performs yet. It says what the product would do and that nothing was sent,
// so the control never silently does nothing (the design's stub rule). The
// component that renders a stub names the issue that builds its write.
import { type ReactNode, useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";

export function DetailsDialog({
  open: openLabel,
  title,
  subtitle,
  testId,
  primary = false,
  stub = false,
  children,
}: {
  open: string;
  title: string;
  subtitle?: string;
  testId: string;
  primary?: boolean;
  /** Marks the opening button as a stub, for the tests and the audit. */
  stub?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-stub={stub ? "" : undefined}
        className={primary ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {openLabel}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        subtitle={subtitle}
        testId={testId}
      >
        {children}
      </SheetDialog>
    </>
  );
}

export function StubDialog({
  open,
  title,
  body,
  testId,
  primary = false,
}: {
  open: string;
  title: string;
  body: string;
  testId: string;
  primary?: boolean;
}) {
  return (
    <DetailsDialog
      open={open}
      title={title}
      testId={testId}
      primary={primary}
      stub
    >
      <p className="text-sm text-muted-foreground">{body}</p>
    </DetailsDialog>
  );
}
