"use client";
/**
 * NotificationsBell — bell icon button that opens a right-side Sheet drawer.
 *
 * Current state: typed empty-state stub. The notifications data layer is
 * out of scope for this phase; the shell component renders correctly and
 * never throws.
 */

import * as React from "react";
import { Bell } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export function NotificationsBell() {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <button
        type="button"
        aria-label="Open notifications"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md",
          "text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <Bell className="h-4 w-4" aria-hidden="true" />
        {/* Future: unread badge goes here */}
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-80 flex-col p-0 sm:w-80">
          <SheetHeader className="border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-sm font-medium">Notifications</SheetTitle>
          </SheetHeader>

          {/* Empty state */}
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Bell
              className="h-8 w-8 text-muted-foreground/30"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">No notifications yet</p>
            <p className="text-xs text-muted-foreground/60">
              Agent completions, approvals, and alerts will appear here.
            </p>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
