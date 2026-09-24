// The Spend page's tabs (#2962): path segments on the one Spend route, the
// current one marked, each with the live count the design shows beside it
// (findings open, runs with waste, ceilings set). A count whose read did not
// answer is left off rather than printed as a zero.
import { useLocale, useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { RouteTabs } from "@/ui/route-tabs";
import { SPEND_TABS, type SpendAt, type SpendTab } from "./view";

export type SpendTabCounts = Partial<Record<SpendTab, number>>;

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
      tabs={SPEND_TABS.map((tab) => {
        const count = counts[tab];
        return {
          to: routes.spend(at.org, at.ws, { tab }),
          label: t(`tabs.${tab}`),
          current: tab === current,
          ...(count === undefined ? {} : { count: formatCount(count, locale) }),
        };
      })}
    />
  );
}
