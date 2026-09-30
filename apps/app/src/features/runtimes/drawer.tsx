"use client";
// The runtime drawer (roadmap mockups `agt-runtime`): one runtime opens beside
// the Runtimes tab of the Agents page, which stays behind it. The URL carries
// the runtime (`?tab=runtimes&runtime=<id>`), so the server renders the body
// and a link can open the drawer. Closing it replaces the entry with the tab's
// own address and keeps the scroll, so the list stays where the person left it.
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

export function RuntimeDrawer({
  title,
  subtitle,
  closeTo,
  children,
}: {
  title: string;
  /** A line under the title: the runtime's kind and platform, or its slug. */
  subtitle?: string;
  /** The Runtimes tab, where closing the drawer lands. */
  closeTo: SafePath;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <SheetDialog
      open
      side
      title={title}
      {...(subtitle === undefined ? {} : { subtitle })}
      onOpenChange={(open) => {
        if (!open) navigate.advance(closeTo);
      }}
      testId="runtime-drawer"
    >
      <div className="flex flex-col gap-3.5">{children}</div>
    </SheetDialog>
  );
}
