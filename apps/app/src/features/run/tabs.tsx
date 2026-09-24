// The Run page's tab strip (mockup `runTabs`, pages/run.md, Tabs): seven
// tabs, each with its live count after the label in the mono dim face, the
// cost in the muted face, and a dot where a call is parked on the run.
//
// A tab is a query value on the run's one route, so it survives a reload and
// a shared link. It is still a tab to assistive tech: `role="tablist"` over
// links carrying `role="tab"` and `aria-selected`, which is what the design's
// buttons carry.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { TranscriptKind } from "@/data/contracts/run";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { tabCount, tabLink } from "@/ui/route-tabs";
import type { Place } from "./tab-props";
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
  kinds: readonly TranscriptKind[];
  place: Place;
}) {
  const t = useTranslations("run.tabs");
  return (
    <div
      role="tablist"
      aria-label={t("label")}
      data-testid="run-tabs"
      className="mb-4 mt-0.5 flex gap-0.5 overflow-x-auto border-b border-border [scrollbar-width:thin]"
    >
      {TABS.map((tab) => {
        const figure = figures[tab] ?? {};
        return (
          <SafeLink
            key={tab}
            role="tab"
            aria-selected={tab === selected}
            aria-current={tab === selected ? "page" : undefined}
            // The Transcript tab keeps the chips a link opened it with, so
            // leaving it for the chain and coming back does not reset them.
            to={routes.run(
              place.org,
              place.ws,
              place.runId,
              tab === "transcript"
                ? { tab, kinds: kindsParam(kinds) }
                : { tab },
            )}
            className={tabLink}
          >
            {figure.label ?? t(tab)}
            {figure.count === undefined ? null : (
              <span
                data-testid={`run-tab-count-${tab}`}
                className={`${tabCount} ${figure.money === true ? "text-muted-foreground" : ""}`}
              >
                {figure.count}
              </span>
            )}
            {figure.parked === true ? (
              <span
                data-testid={`run-tab-parked-${tab}`}
                title={t("parked")}
                className="ml-0.5 inline-block size-1.5 rounded-full bg-info align-middle"
              />
            ) : null}
          </SafeLink>
        );
      })}
    </div>
  );
}
