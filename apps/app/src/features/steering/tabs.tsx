// The Steering page's tabs (#2961): links with the current one marked, since a
// tab is a query on the one Steering route.
import { useTranslations } from "next-intl";
import { SafeLink } from "@/ui/navigation";
import {
  STEERING_TABS,
  type SteeringAt,
  type SteeringTab,
  steeringLink,
} from "./view";

export function SteeringTabs({
  at,
  current,
}: {
  at: SteeringAt;
  current: SteeringTab;
}) {
  const t = useTranslations("steering.tabs");
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {STEERING_TABS.map((tab) => (
        <SafeLink
          key={tab}
          to={steeringLink(at, { tab })}
          data-tab={tab}
          aria-current={tab === current ? "page" : undefined}
          className="-mb-px min-h-11 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
        >
          {t(tab)}
        </SafeLink>
      ))}
    </nav>
  );
}
