// The Run page's tab strip (mockup `runTabs`, pages/run.md, Tabs): seven
// tabs, each with its live count after the label in the mono dim face, the
// cost in the muted face, and a dot where a call is parked on the run.
//
// A tab is a query value on the run's one route, so it survives a reload and
// a shared link. The strip is a `RouteTabs` row (ADR-NEW-route-tabs-are-tabs):
// a tablist of links, one tab stop, and the arrow keys. Only the open tab's
// panel is on the page, so only the open tab names it, and the panel the page
// draws under the strip (`RUN_TAB_PANEL`) takes that tab as its label.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { routes } from "@/shared/safe-path";
import { RouteTabs } from "@/ui/route-tabs";
import type { KindFilter, Place } from "./tab-props";
import { kindsParam } from "./transcript";

/** The seven tabs, in the spec's order (pages/run.md). */
const TABS = [
  "transcript",
  "issues",
  "actions",
  "cost",
  "policy",
  "context",
  "chain",
] as const;
export type Tab = (typeof TABS)[number];

/**
 * Tab names an older link may still carry. Frames and Approvals became one
 * Governed actions tab, and the design's retired Proof, Done and Ladder keys
 * land on Cost, so a bookmark to any of them opens a tab that exists.
 */
const TAB_ALIASES: Record<string, Tab> = {
  frames: "actions",
  approvals: "actions",
  player: "actions",
  proof: "cost",
  dod: "cost",
  ladder: "cost",
};

/** The id of the open tab's panel, which the page draws under the strip. */
export const RUN_TAB_PANEL = "run-tab-panel";

export function tabOf(raw: string | null): Tab {
  return (
    TABS.find((name) => name === raw) ??
    (raw === null ? undefined : TAB_ALIASES[raw]) ??
    "transcript"
  );
}

export type TabFigure = {
  /** The count after the label; undefined draws none, never a zero it cannot back. */
  count?: ReactNode;
  /** The count is money, which reads in the muted face rather than the dim. */
  money?: boolean;
  /** A call is parked for approval on the run. */
  parked?: boolean;
  /** Governed actions reads "Player" on a run with no policy decision. */
  label?: string;
};

export function RunTabs({
  selected,
  figures,
  kinds,
  place,
}: {
  selected: Tab;
  figures: Partial<Record<Tab, TabFigure>>;
  kinds: KindFilter;
  place: Place;
}) {
  const t = useTranslations("run.tabs");
  return (
    <div data-testid="run-tabs" className="mb-4 mt-0.5">
      <RouteTabs
        label={t("label")}
        panel={RUN_TAB_PANEL}
        tabs={TABS.map((tab) => {
          const figure = figures[tab] ?? {};
          return {
            // The Transcript tab keeps the chips a link opened it with, so
            // leaving it for the chain and coming back does not reset them.
            to: routes.run(
              place.org,
              place.ws,
              place.runId,
              tab === "transcript"
                ? { tab, kinds: kindsParam(kinds) }
                : { tab },
            ),
            label: figure.label ?? t(tab),
            current: tab === selected,
            name: tab,
            ...(figure.count === undefined
              ? {}
              : {
                  count: (
                    <span
                      data-testid={`run-tab-count-${tab}`}
                      className={
                        figure.money === true
                          ? "text-muted-foreground"
                          : undefined
                      }
                    >
                      {figure.count}
                    </span>
                  ),
                }),
            ...(figure.parked === true
              ? {
                  // The dot is the sighted reading. The sentence inside it is
                  // the same fact for a screen reader, and on a touch screen,
                  // where a `title` never shows.
                  mark: (
                    <span
                      data-testid={`run-tab-parked-${tab}`}
                      title={t("parked")}
                      className="ml-0.5 inline-block size-1.5 rounded-full bg-info align-middle"
                    >
                      <span className="sr-only">{t("parked")}</span>
                    </span>
                  ),
                }
              : {}),
          };
        })}
      />
    </div>
  );
}
