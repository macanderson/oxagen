"use client";
// The Steering hub's five tabs (roadmap pages/steering.md): Library,
// Assignments, Gates, Proposals, Compiler, in that order, each a link to its
// own path so a tab survives a reload and a shared link. The row is a
// `RouteTabs` row (ADR-NEW-route-tabs-are-tabs), which carries the tabs
// pattern: one tab stop, the arrow keys, Home and End, and Enter or Space to
// follow a tab. The selected tab names the panel (./steering.tsx), and the
// panel takes that tab as its label.
//
// A count sits after a label only where the record stands behind it: the
// Library's items and the proposals waiting. Assignments, Gates and the
// Compiler print none until their reads exist, rather than a zero nobody
// counted. On a phone the strip is one row that scrolls with snap, and the
// selected tab is scrolled into the row when it changes.
import { useTranslations } from "next-intl";
import { RouteTabs } from "@/ui/route-tabs";
import {
  STEERING_TABS,
  type SteeringAt,
  type SteeringTab,
  steeringLink,
  TAB_PANEL_ID,
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
  return (
    <div data-testid="steering-tabs" className="min-w-0">
      <RouteTabs
        label={t("label")}
        panel={TAB_PANEL_ID}
        tabs={STEERING_TABS.map((tab) => {
          const count = counts[tab];
          return {
            to: steeringLink(at, { tab }),
            label: t(tab),
            current: tab === current,
            name: tab,
            ...(count === undefined || count === null || count === 0
              ? {}
              : { count }),
          };
        })}
      />
    </div>
  );
}
