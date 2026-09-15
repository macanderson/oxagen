// The Spend page's tabs (#2962): links with the current one marked, since a
// tab is a query on the one Spend route.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { SPEND_TABS, type SpendAt, type SpendTab } from "./view";

export function SpendTabs({ at, current }: { at: SpendAt; current: SpendTab }) {
  const t = useTranslations("spend");
  return (
    <nav
      aria-label={t("tabs.label")}
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {SPEND_TABS.map((tab) => (
        <SafeLink
          key={tab}
          to={routes.spend(at.org, at.ws, { tab })}
          data-tab={tab}
          aria-current={tab === current ? "page" : undefined}
          className="-mb-px min-h-11 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
        >
          {t(`tabs.${tab}`)}
        </SafeLink>
      ))}
    </nav>
  );
}
