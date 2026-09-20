// Tabs that are URL segments (ARCHITECTURE.md §1.2): a page with two or more
// real tabs links each one to its own route and marks the current one with
// aria-current, so the tab survives a reload and a shared link.
import type { SafePath } from "@/shared/safe-path";
import { SafeLink } from "./navigation";

export type RouteTab = { to: SafePath; label: string; current: boolean };

export function RouteTabs({
  label,
  tabs,
}: {
  label: string;
  tabs: readonly RouteTab[];
}) {
  return (
    <nav
      aria-label={label}
      className="min-w-0 overflow-x-auto border-b border-border"
    >
      <ul className="-mb-px flex w-max min-w-full gap-1">
        {tabs.map((tab) => (
          <li key={tab.to}>
            <SafeLink
              to={tab.to}
              aria-current={tab.current ? "page" : undefined}
              className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
            >
              {tab.label}
            </SafeLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
