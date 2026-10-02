"use client";
// The keyboard of a tab row (ADR-243, #3995). RouteTabs
// draws the tabs; this module holds the one part that needs the browser. The
// selected tab is the row's one stop in the tab order. The arrow keys, Home,
// and End move focus along the row, and Enter or Space follows the focused
// tab's link. A key pressed with Alt, Control, or Meta is the browser's, so
// Alt+ArrowLeft still goes back.
//
// On a phone the row scrolls sideways, so the selected tab is scrolled into
// the row when it changes. Only the row scrolls, never the page.
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";

/** The tab focus moves to for a key, or null when the key is not a move. */
function nextTab(
  key: string,
  from: number,
  last: number,
): number | null {
  switch (key) {
    case "ArrowRight":
      return from === last ? 0 : from + 1;
    case "ArrowLeft":
      return from === 0 ? last : from - 1;
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

export function TabRow({
  label,
  selected,
  rowClassName,
  listClassName,
  children,
}: {
  label: string;
  /** The selected tab's index, or -1 when no tab in the row is selected. */
  selected: number;
  rowClassName: string;
  listClassName: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (row === null) return;
    const tab = row.querySelector<HTMLElement>(
      '[role="tab"][aria-selected="true"]',
    );
    if (tab === null) return;
    const edge = row.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left < edge.left || box.right > edge.right) {
      row.scrollLeft += box.left - edge.left;
    }
  }, [selected]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const tabs = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        ':scope > [role="tab"]',
      ),
    ];
    const from =
      event.target instanceof HTMLElement ? tabs.indexOf(event.target) : -1;
    if (from === -1) return;
    if (event.key === " ") {
      // A link follows on Enter alone. A tab follows on Space too.
      event.preventDefault();
      tabs[from]?.click();
      return;
    }
    const to = nextTab(event.key, from, tabs.length - 1);
    if (to === null) return;
    event.preventDefault();
    tabs[to]?.focus();
  };
  return (
    <div ref={rowRef} data-tab-row="" className={rowClassName}>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={listClassName}
      >
        {children}
      </div>
    </div>
  );
}
