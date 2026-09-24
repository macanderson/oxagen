"use client";
// The `evidence` dialog (spec "Findings"): one finding's evidence, rendered
// on the server and opened over the Findings list by `?finding=`. It opens
// with the page, and closing it returns to the list, so the dialog survives a
// reload and a shared link the way the rest of the page does.
import type { ReactNode } from "react";
import { useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

export function EvidenceDialog({
  title,
  subtitle,
  close,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Where closing the dialog goes: the list it opened over. */
  close: SafePath;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) navigate.replace(close);
      }}
      title={title}
      {...(subtitle === undefined ? {} : { subtitle })}
      wide
      testId="spend-evidence-dialog"
    >
      {children}
    </SheetDialog>
  );
}
