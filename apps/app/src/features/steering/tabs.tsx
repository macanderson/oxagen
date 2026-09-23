"use client";
// The Steering hub's five tabs (roadmap pages/steering.md): Library,
// Assignments, Gates, Proposals, Compiler, in that order, each a link to its
// own path so a tab survives a reload and a shared link. `role="tab"` with
// `aria-selected` is the design's markup; the link keeps the address.
//
// A count sits after a label only where the record stands behind it: the
// Library's items and the proposals waiting. Assignments, Gates and the
// Compiler print none until their reads exist, rather than a zero nobody
// counted. On a phone the strip is one row that scrolls with snap, and the
// selected tab is scrolled into view on render.
//
// The keyboard follows the tabs pattern: the selected tab is the one stop in
// the tab order, the arrow keys, Home and End move focus along the strip, and
// Enter or Space follows the focused tab's link. Each tab names the panel it
// controls, and the panel (./steering.tsx) names its tab as its label.
import { useTranslations } from "next-intl";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { SafeLink } from "@/ui/navigation";
import {
  STEERING_TABS,
  type SteeringAt,
  type SteeringTab,
  steeringLink,
  TAB_PANEL_ID,
  tabId,
} from "./view";

/** The tab focus moves to for a key, or null when the key is not a move. */
function nextTab(key: string, from: number): number | null {
  const last = STEERING_TABS.length - 1;
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

export type SteeringTabCounts = Partial<Record<SteeringTab, number | null>>;

export function SteeringTabs({
  at,
  current,
  counts,
}: {
  at: SteeringAt;
  current: SteeringTab;
  counts: SteeringTabCounts;
}) {
  const t = useTranslations("steering.tabs");
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const selected = strip.current?.querySelector<HTMLElement>(
      '[aria-selected="true"]',
    );
    // jsdom has no layout, so it has no scrollIntoView either.
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [current]);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [
      ...(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
    ];
    const from = tabs.indexOf(event.target as HTMLElement);
    if (from === -1) return;
    const to = nextTab(event.key, from);
    if (to === null) return;
    event.preventDefault();
    tabs[to]?.focus();
  };
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={t("label")}
      onKeyDown={move}
      data-testid="steering-tabs"
      className="flex min-w-0 snap-x snap-mandatory gap-0.5 overflow-x-auto border-b border-border"
    >
      {STEERING_TABS.map((tab) => {
        const count = counts[tab];
        return (
          <SafeLink
            key={tab}
            id={tabId(tab)}
            role="tab"
            to={steeringLink(at, { tab })}
            data-tab={tab}
            aria-selected={tab === current}
            aria-controls={tab === current ? TAB_PANEL_ID : undefined}
            tabIndex={tab === current ? 0 : -1}
            onKeyDown={(event) => {
              // A link follows on Enter alone; a tab follows on Space too.
              if (event.key !== " ") return;
              event.preventDefault();
              event.currentTarget.click();
            }}
            className={`${tabLink} snap-start aria-selected:border-gold aria-selected:text-foreground`}
          >
            {t(tab)}
            {count === undefined || count === null || count === 0 ? null : (
              <span className={tabCount}>{count}</span>
            )}
          </SafeLink>
        );
      })}
    </div>
  );
}
