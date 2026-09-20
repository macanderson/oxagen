// The Tools page's tabs (#2958): links with the current one marked, since a
// tab is a query on the one Tools route. A count appears only where something
// waits on a person — the switches that are denying right now.
import { useTranslations } from "next-intl";
import { SafeLink } from "@/ui/navigation";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { TOOLS_TABS, type ToolsAt, type ToolsTab, toolsLink } from "./view";

export function ToolsTabs({
  at,
  current,
  switchesOn,
  switchesOnIsFloor,
}: {
  at: ToolsAt;
  current: ToolsTab;
  /** How many switches are denying, or null when the read did not answer. */
  switchesOn: number | null;
  /**
   * True when the board the count was taken from was truncated, so the count
   * is a floor. A count in navigation is a promise that this is how many
   * things wait on a person; when the read could not say, it says so rather
   * than rounding a floor up into a total.
   */
  switchesOnIsFloor: boolean;
}) {
  const t = useTranslations("tools.tabs");
  return (
    <nav
      aria-label={t("label")}
      className="flex flex-wrap gap-0.5 border-b border-border"
    >
      {TOOLS_TABS.map((tab) => (
        <SafeLink
          key={tab}
          to={toolsLink(at, { tab })}
          data-tab={tab}
          aria-current={tab === current ? "page" : undefined}
          className={tabLink}
        >
          {t(tab)}
          {tab === "switches" && switchesOn !== null && switchesOn > 0 ? (
            <span
              data-count="switches-on"
              className={`${tabCount} text-error-ink`}
            >
              {switchesOnIsFloor
                ? t("switchesOnAtLeast", { count: switchesOn })
                : t("switchesOn", { count: switchesOn })}
            </span>
          ) : null}
        </SafeLink>
      ))}
    </nav>
  );
}
