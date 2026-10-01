// The Spend page's tabs (#2962): path segments on the one Spend route, the
// current one selected, each with the live count the design shows beside it
// (findings open, runs with waste, ceilings set). A count whose read did not
// answer is left off rather than printed as a zero. The row is a `RouteTabs`
// row (ADR-243), and the selected tab names the panel the
// page draws under it (`SPEND_PANEL`).
import { useLocale, useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { RouteTabs } from "@/ui/route-tabs";
import { SPEND_TABS, type SpendAt, type SpendTab } from "./view";

export type SpendTabCounts = Partial<Record<SpendTab, number>>;

/** The id of the panel the page draws under the tabs. */
export const SPEND_PANEL = "spend-panel";

export function SpendTabs({
  at,
  current,
  counts,
}: {
  at: SpendAt;
  current: SpendTab;
  counts: SpendTabCounts;
}) {
  const t = useTranslations("spend");
  const locale = useLocale();
  return (
    <RouteTabs
      label={t("tabs.label")}
      panel={SPEND_PANEL}
      tabs={SPEND_TABS.map((tab) => {
        const count = counts[tab];
        return {
          to: routes.spend(at.org, at.ws, { tab }),
          label: t(`tabs.${tab}`),
          current: tab === current,
          name: tab,
          ...(count === undefined ? {} : { count: formatCount(count, locale) }),
        };
      })}
    />
  );
}
