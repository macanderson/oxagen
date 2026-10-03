"use client";
// The Details drawer of the Run page (run-header spec, Details drawer): every
// fact the head leaves out, in a drawer on the right. The URL carries it
// (`?details=<section>`), so the server renders the body and a link can open
// it at a section. Closing it replaces the entry with the same address
// without `details` and keeps the scroll, so the page stays where the person
// left it.
import { type ReactNode, useEffect } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

export function RunDetailsDrawer({
  title,
  subtitle,
  closeTo,
  children,
}: {
  title: string;
  /** The run's title. */
  subtitle: string;
  /** The run page without `details`, where closing the drawer lands. */
  closeTo: SafePath;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <SheetDialog
      open
      side
      title={title}
      subtitle={subtitle}
      onOpenChange={(open) => {
        if (!open) navigate.advance(closeTo);
      }}
      testId="run-details"
    >
      <div className="flex flex-col gap-5">{children}</div>
    </SheetDialog>
  );
}

/**
 * Scrolls the section a link asked for into view once the drawer has drawn
 * it. It renders inside the drawer, after the sections, so the section is in
 * the document when its effect runs.
 */
export function ScrollToSection({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [id]);
  return null;
}
