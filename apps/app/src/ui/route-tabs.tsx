// Tabs that are URL segments (ARCHITECTURE.md §1.2): each tab links to its own
// route, so the tab survives a reload and a shared link.
//
// Every row is a tab widget (ADR-NEW-route-tabs-are-tabs, #3995). The row is a
// tablist with the row's label, each link is a tab, and the selected tab
// carries `aria-selected`. The selected tab is the row's one stop in the tab
// order, and the arrow keys, Home, and End move along the row (./tab-row.tsx).
// Each tab is still a link, so Enter follows it and a middle click opens it in
// a new browser tab.
//
// Only the selected tab's panel is on the page, so only the selected tab names
// a panel in `aria-controls`. The page draws its body in `RouteTabPanel` with
// the same `panel` id, and the panel takes the selected tab as its label. A
// reference to a panel the page did not draw would point at nothing.
//
// `.tab { padding:8px 13px; font-size:13px; color:var(--muted);
// border-bottom:2px solid transparent }` and `.tab[aria-selected] {
// color:var(--fg); border-bottom-color:var(--gold) }` (engine.css, ADR-226):
// the selected tab is underlined in the gold, and a count after a label is
// mono and dim. The `pill` look is the smaller row of views inside a tab
// (features/tools/tabs.tsx), so it reads as part of the tab.
//
// On a phone the row scrolls sideways and snaps each tab to its start
// (`#viewport.phone .tabs{scroll-snap-type:x proximity}`): src/ui/phone.css
// keys on `data-tab-row` and `data-tab`.
import type { ComponentProps, ReactNode } from "react";
import type { SafePath } from "@/shared/safe-path";
import { SafeLink } from "./navigation";
import { TabRow } from "./tab-row";

export type RouteTab = {
  to: SafePath;
  label: string;
  current: boolean;
  /** The tab's own name, drawn as `data-tab` so a test or a script can find it. */
  name?: string;
  /** A count the record can stand behind, e.g. proposals waiting; omitted when none. */
  count?: ReactNode;
  /** A mark after the count, such as the dot for a call parked on a run. It is read as part of the tab's name. */
  mark?: ReactNode;
};

/** The one tab recipe. */
export const tabLink =
  "-mb-px inline-flex min-h-10 max-md:min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-[13px] py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:border-gold aria-selected:text-foreground";
export const tabCount = "font-mono text-[10.5px] font-normal text-dim";

/** The smaller row of views inside one tab. */
const pillTab =
  "inline-flex min-h-7 max-md:min-h-11 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-hl hover:text-foreground " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:border-foreground/30 aria-selected:bg-hl aria-selected:text-foreground";

const LOOKS = {
  underline: {
    row: "min-w-0 overflow-x-auto border-b border-border",
    list: "flex w-max min-w-full gap-0.5",
    tab: tabLink,
    count: tabCount,
  },
  pill: {
    row: "min-w-0",
    list: "flex flex-wrap gap-1.5",
    tab: pillTab,
    count: "text-muted-foreground",
  },
} as const;

/** The id of the selected tab, which labels the panel `panel` names. */
export function routeTabId(panel: string): string {
  return `${panel}-tab`;
}

export function RouteTabs({
  label,
  panel,
  tabs,
  look = "underline",
}: {
  label: string;
  /** The id of the panel the page draws under the row (`RouteTabPanel`). */
  panel: string;
  tabs: readonly RouteTab[];
  look?: keyof typeof LOOKS;
}) {
  const style = LOOKS[look];
  const selected = tabs.findIndex((tab) => tab.current);
  return (
    <TabRow
      label={label}
      selected={selected}
      rowClassName={style.row}
      listClassName={style.list}
    >
      {tabs.map((tab, index) => {
        const open = index === selected;
        // A row with no tab selected still needs one stop in the tab order.
        const stop = open || (selected === -1 && index === 0);
        return (
          <SafeLink
            key={tab.to}
            to={tab.to}
            role="tab"
            id={open ? routeTabId(panel) : undefined}
            aria-selected={open}
            aria-controls={open ? panel : undefined}
            tabIndex={stop ? 0 : -1}
            data-tab={tab.name ?? ""}
            className={style.tab}
          >
            {tab.label}
            {tab.count === undefined ? null : (
              <span className={style.count}>{tab.count}</span>
            )}
            {tab.mark ?? null}
          </SafeLink>
        );
      })}
    </TabRow>
  );
}

/**
 * The body under a row of route tabs. `labelled` is false on a page that
 * renders under the row with no tab selected, because the panel then has no
 * tab to take its name from.
 */
export function RouteTabPanel({
  panel,
  labelled = true,
  ...props
}: Omit<ComponentProps<"div">, "id" | "role" | "aria-labelledby"> & {
  panel: string;
  labelled?: boolean;
}) {
  return (
    <div
      {...props}
      role="tabpanel"
      id={panel}
      aria-labelledby={labelled ? routeTabId(panel) : undefined}
    />
  );
}
