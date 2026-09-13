"use client";
/**
 * session-settings-host.tsx — the three chrome wrappers around `SessionSettings`:
 * a full-screen mobile drawer, a desktop right slide-over, and an always-on
 * rail card. Each renders the same `<SessionSettings variant=…>` content —
 * only the surrounding surface differs.
 */
import * as React from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// ---------------------------------------------------------------------------
// Mobile — full-screen drawer
// ---------------------------------------------------------------------------

export interface SessionSettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/**
 * Full-screen mobile drawer. Covers the entire viewport (not the usual 3/4-
 * width side sheet) and respects the bottom safe-area inset for devices with
 * a home indicator. `SheetPopup` already renders the close X (accessible name
 * "Close") — no need to add a second one.
 */
export function SessionSettingsDrawer({
  open,
  onOpenChange,
  children,
}: SessionSettingsDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="bottom"
        className={cn(
          "inset-x-0 top-0 flex h-[100dvh] max-h-none w-full max-w-none flex-col gap-0 rounded-none border-0 p-0",
          "pb-[env(safe-area-inset-bottom)]",
          "duration-200 motion-reduce:transition-none motion-reduce:duration-0",
        )}
      >
        <SheetHeader className="flex-row items-center justify-between border-b border-border px-4 py-3 text-left">
          <SheetTitle>Session settings</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </SheetPopup>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Desktop — right slide-over
// ---------------------------------------------------------------------------

export interface SessionSettingsSlideOverProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

/** Right slide-over panel. Esc closes and focus is trapped — both are the
 * Base UI `Dialog` (Sheet)'s default modal behavior, not custom code here. */
export function SessionSettingsSlideOver({
  open,
  onOpenChange,
  children,
}: SessionSettingsSlideOverProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup
        side="right"
        className="flex w-[360px] max-w-[90vw] flex-col gap-0 p-0"
      >
        <SheetHeader className="border-b border-border px-4 py-3 text-left">
          <SheetTitle>Session settings</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </SheetPopup>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Rail — always-on card
// ---------------------------------------------------------------------------

export interface SessionSettingsRailProps {
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}

/**
 * Plain bordered card matching `AgentActivityRail`'s `RailCard` header rhythm
 * (icon · title · collapse chevron) — that component isn't exported, so this
 * reproduces the same look rather than importing it.
 */
export function SessionSettingsRail({
  children,
  className,
  defaultOpen = true,
}: SessionSettingsRailProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <section
      data-component="session-settings-rail"
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <SlidersHorizontal
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="flex-1 truncate text-sm font-semibold">Session</span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="border-t border-border/60 px-3 pb-3 pt-2.5">
          {children}
        </div>
      ) : null}
    </section>
  );
}
