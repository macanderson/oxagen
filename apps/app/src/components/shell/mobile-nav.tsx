"use client";
/**
 * MobileNav — hamburger trigger + off-canvas Sheet drawer for sub-`md` viewports.
 *
 * Mode-aware: derives SidebarMode from the current pathname + ScopeContext and
 * renders the appropriate nav items. Org/Workspace switchers appear in the
 * drawer header on mobile.
 *
 * Uses the same getSidebarConfig / resolveSidebarMode as the desktop Sidebar so
 * nav items are always in sync.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from "@/components/ui/sheet";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { getSidebarConfig, resolveSidebarMode } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import type { ScopeContext } from "@/lib/scope";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";

export interface MobileNavProps {
  ctx: ScopeContext;
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  user: SessionUser;
}

/** Hamburger button + slide-in Sheet drawer for sub-`md` viewports. */
export function MobileNav({
  ctx,
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
}: MobileNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode);

  const allItems = config.items;

  return (
    <>
      {/* Trigger — shown only below md */}
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="left" className="flex w-72 max-w-[85vw] flex-col p-0">
          {/* Drawer header — switchers on mobile */}
          <SheetHeader className="flex-col items-start gap-2 border-b px-4 py-3">
            <SheetTitle className="sr-only">Navigation</SheetTitle>

            {/* User display */}
            <div className="flex w-full items-center justify-between">
              <span className="truncate text-xs text-muted-foreground">
                {user.name ?? user.email}
              </span>
            </div>

            {/* Switcher chips stacked on mobile */}
            <div className="flex w-full flex-col gap-1.5">
              <OrgSwitcher current={org} organizations={availableOrgs} />
              {workspace && (
                <WorkspaceSwitcher
                  orgSlug={org.slug}
                  current={workspace}
                  workspaces={availableWorkspaces ?? []}
                />
              )}
            </div>
          </SheetHeader>

          {/* Nav items */}
          <nav
            className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2"
            aria-label="Primary navigation"
          >
            {allItems.map((item) => {
              const href = item.href(ctx);
              const isActive = pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
              const Icon = item.icon;
              return (
                <SheetClose
                  key={item.id}
                  render={
                    <Link
                      href={href}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex min-h-[2.75rem] items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isActive
                          ? "bg-brand/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          isActive ? "text-brand" : undefined,
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Link>
                  }
                />
              );
            })}
          </nav>
        </SheetPopup>
      </Sheet>
    </>
  );
}
