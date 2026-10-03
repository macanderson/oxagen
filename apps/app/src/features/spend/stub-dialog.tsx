"use client";
// A control the design draws whose write has no contract yet: Request access
// on the denied state, Open an incident on the error state, and Export this
// view on a drill. It opens a dialog that says what the product would do and
// that nothing was sent, so no button on the page silently does nothing (spec:
// "Stub controls say what the product would do"). The backend issue that
// would back it rides as a data attribute.
import { useState } from "react";
import { Button } from "@/ui/button";
import { SheetDialog } from "@/ui/sheet-dialog";

export function StubDialog({
  label,
  title,
  body,
  issue,
  testId,
  primary = false,
}: {
  /** The trigger's label. */
  label: string;
  title: string;
  /** What the control would do, and that nothing was sent. */
  body: string;
  /** The oxageninc/product issue that would back it. */
  issue: number;
  testId: string;
  /** The screen's one gold action. */
  primary?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        data-touch-target=""
        variant={primary ? "primary" : "outline"}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        testId={testId}
      >
        <p
          data-issue={issue}
          className="text-sm leading-relaxed text-muted-foreground"
        >
          {body}
        </p>
      </SheetDialog>
    </>
  );
}
