// The Tools page's tabs (#2958): links with the current one marked, since a
// tab is a query on the one Tools route. A count appears only where something
// waits on a person — the switches that are denying right now.
import { useTranslations } from "next-intl";
import { SafeLink } from "@/ui/navigation";
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
      className="flex flex-wrap gap-1 border-b border-border"
    >
      {TOOLS_TABS.map((tab) => (
        <SafeLink
          key={tab}
          to={toolsLink(at, { tab })}
          data-tab={tab}
          aria-current={tab === current ? "page" : undefined}
          className="-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
        >
          {t(tab)}
          {tab === "switches" && switchesOn !== null && switchesOn > 0 ? (
            <span
              data-count="switches-on"
              className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium tabular-nums text-foreground"
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
