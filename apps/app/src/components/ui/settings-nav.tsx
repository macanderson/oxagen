"use client";

/**
 * SettingsNav — vertical sidebar navigation for settings pages.
 *
 * Renders a list of nav links in a left-hand column. Active link is determined
 * by longest-prefix match against the current pathname (same logic as PageTabs).
 *
 * Integration contract:
 *   import { SettingsNav } from "@/components/ui/settings-nav"
 *   <SettingsNav
 *     items={[
 *       { label: "General", href: "/acme/prod/settings/general" },
 *       { label: "Members", href: "/acme/prod/settings/members" },
 *     ]}
 *   />
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { resolveActiveTab } from "@/lib/resolve-active-tab";

export interface SettingsNavItem {
  label: string;
  href: string;
}

export interface SettingsNavProps {
  items: SettingsNavItem[];
  className?: string;
}

export function SettingsNav({ items, className }: SettingsNavProps) {
  const pathname = usePathname();
  const activeHref = resolveActiveTab(items, pathname);

  return (
    <nav
      aria-label="Settings"
      className={cn("flex flex-col gap-0.5", className)}
    >
      {items.map((item) => {
        const isActive = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative rounded-md px-3 py-2 text-sm font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
