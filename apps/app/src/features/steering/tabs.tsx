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
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { SafeLink } from "@/ui/navigation";
import {
  STEERING_TABS,
  type SteeringAt,
  type SteeringTab,
  steeringLink,
} from "./view";

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
  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={t("label")}
      data-testid="steering-tabs"
      className="flex min-w-0 snap-x snap-mandatory gap-0.5 overflow-x-auto border-b border-border"
    >
      {STEERING_TABS.map((tab) => {
        const count = counts[tab];
        return (
          <SafeLink
            key={tab}
            role="tab"
            to={steeringLink(at, { tab })}
            data-tab={tab}
            aria-selected={tab === current}
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
