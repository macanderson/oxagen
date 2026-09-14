// Tabs as URL segments (plan §4.10): each tab is a link to its own segment,
// the current one is marked with aria-current, and the default tab renders in
// place with no redirect. A Server Component: it needs no client state, and
// the router's prefetch makes switching instant.
import type { Route } from "next";
import Link from "next/link";
import { cx } from "./cx";

export type RouteTab = {
  id: string;
  href: Route;
  /** Already translated. */
  label: string;
  /** An optional count shown after the label (pending approvals, open proposals). */
  count?: number | undefined;
};

export type RouteTabsProps = {
  /** The accessible name of the tab set (e.g. "Tools sections"). */
  label: string;
  tabs: readonly RouteTab[];
  current: string;
};

export function RouteTabs({ label, tabs, current }: RouteTabsProps) {
  return (
    <nav aria-label={label} className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max items-center gap-1 border-b border-tab-border px-1">
        {tabs.map((tab) => {
          const isCurrent = tab.id === current;
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={isCurrent ? "page" : undefined}
                data-testid={`route-tab-${tab.id}`}
                className={cx(
                  "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isCurrent
                    ? "border-tab-border-active text-tab-fg-active"
                    : "border-transparent text-tab-fg hover:border-tab-border-hover hover:text-tab-fg-hover",
                )}
              >
                {tab.label}
                {tab.count !== undefined ? (
                  <span className="rounded-full border border-border px-1.5 text-[11px] leading-4 tabular-nums text-muted-foreground">
                    {tab.count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
