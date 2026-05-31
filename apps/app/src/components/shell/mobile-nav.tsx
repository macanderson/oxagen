"use client";
import * as React from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { MessageSquare, Settings, Users, Workflow, Bot, Activity, CreditCard } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const workspaceNav = [
  { href: "chat", label: "Chat", icon: MessageSquare },
  { href: "agents", label: "Agents", icon: Bot },
  { href: "playbooks", label: "Playbooks", icon: Workflow },
  { href: "executions", label: "Executions", icon: Activity },
  { href: "settings", label: "Settings", icon: Settings },
];

const orgNav = [
  { href: "settings/billing", label: "Billing", icon: CreditCard },
  { href: "settings/members", label: "Members", icon: Users },
];

export interface MobileNavProps {
  orgSlug: string;
  workspaceSlug?: string;
}

/** Hamburger button + slide-in Sheet drawer for sub-`md` viewports. */
export function MobileNav({ orgSlug, workspaceSlug }: MobileNavProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      {/* Trigger — shown only below md */}
      <button
        type="button"
        aria-label="Open navigation menu"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center rounded-xl p-2 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-foreground md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="w-72 max-w-[85vw] p-0">
          <SheetHeader className="border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-sm font-semibold tracking-wide">Navigation</SheetTitle>
          </SheetHeader>

          <nav className="flex flex-col gap-1 overflow-y-auto p-3" aria-label="Primary navigation">
            {workspaceSlug ? (
              <>
                <div className="px-2 pb-1 pt-2 text-xs uppercase tracking-wider text-muted-foreground">
                  Workspace
                </div>
                {workspaceNav.map(({ href, label, icon: Icon }) => (
                  <SheetClose asChild key={href}>
                    <Link
                      href={`/${orgSlug}/${workspaceSlug}/${href}`}
                      className={cn(
                        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground",
                        "transition-colors hover:bg-accent/10 hover:text-foreground",
                        "active:scale-[0.98]",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  </SheetClose>
                ))}
                <div className="mt-3 px-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">
                  Organization
                </div>
              </>
            ) : null}

            {orgNav.map(({ href, label, icon: Icon }) => (
              <SheetClose asChild key={href}>
                <Link
                  href={`/${orgSlug}/${href}`}
                  className={cn(
                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground",
                    "transition-colors hover:bg-accent/10 hover:text-foreground",
                    "active:scale-[0.98]",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              </SheetClose>
            ))}
          </nav>
        </SheetContent>
      </Sheet>
    </>
  );
}
