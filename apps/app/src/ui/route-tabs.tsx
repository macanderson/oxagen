// Tabs that are URL segments (ARCHITECTURE.md §1.2): a page with two or more
// real tabs links each one to its own route and marks the current one with
// aria-current, so the tab survives a reload and a shared link.
//
// `tablist` opts a row into the design's tab semantics (engine.js draws
// `role="tablist"` and `role="tab" aria-selected`): the list becomes the
// tablist, each link a tab, and the current one is selected as well as
// current. Each tab is still a link to its own URL, so the keyboard moves
// between them with Tab, and Enter opens one (#3995).
//
// `.tab { padding:8px 13px; font-size:13px; color:var(--muted);
// border-bottom:2px solid transparent }` and `.tab[aria-selected] {
// color:var(--fg); border-bottom-color:var(--gold) }` (engine.css, ADR-132):
// the current tab is underlined in the gold, and a count after a label is
// mono and dim.
//
// On a phone the row scrolls sideways and snaps each tab to its start
// (`#viewport.phone .tabs{scroll-snap-type:x proximity}`): src/ui/phone.css
// keys on `data-tab-row` and `data-tab`.
import type { ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { SafeLink } from "./navigation";

export type RouteTab = {
  to: SafePath;
  label: string;
  current: boolean;
  /** A count the record can stand behind, e.g. proposals waiting; omitted when none. */
  count?: ReactNode;
};

/** The one tab recipe, for a nav that draws its own tabs (tools/tabs.tsx). */
export const tabLink =
  "-mb-px inline-flex min-h-10 max-md:min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-[13px] py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-gold aria-[current=page]:text-foreground";
export const tabCount = "font-mono text-[10.5px] font-normal text-dim";

export function RouteTabs({
  label,
  tabs,
  tablist = false,
}: {
  label: string;
  tabs: readonly RouteTab[];
  /** Draw the row as a tablist of tabs, as the design's tab rows are. */
  tablist?: boolean;
}) {
  return (
    <nav
      aria-label={label}
      data-tab-row=""
      className="min-w-0 overflow-x-auto border-b border-border"
    >
      <ul
        className="flex w-max min-w-full gap-0.5"
        role={tablist ? "tablist" : undefined}
        aria-label={tablist ? label : undefined}
      >
        {tabs.map((tab) => (
          <li
            key={tab.to}
            data-tab=""
            role={tablist ? "presentation" : undefined}
          >
            <SafeLink
              to={tab.to}
              role={tablist ? "tab" : undefined}
              aria-selected={tablist ? tab.current : undefined}
              aria-current={tab.current ? "page" : undefined}
              className={tabLink}
            >
              {tab.label}
              {tab.count === undefined ? null : (
                <span className={tabCount}>{tab.count}</span>
              )}
            </SafeLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
