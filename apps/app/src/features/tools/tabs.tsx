// The Tools page's five tabs (mockup `tools.md`): Tools, Toolbelts, Providers,
// Policy and Kill switches, each a path segment. The strip is a tablist of
// links, each marked with `aria-selected` and `aria-current`, and it scrolls in
// its own row on a phone rather than wrapping.
//
// Each count is one the record can stand behind. Tools counts the versions of
// the registry's first page, with a plus when a later page exists, because the
// read carries no total. Providers counts the roster. Kill switches counts the
// switches denying right now, the one count that waits on a person. Toolbelts
// carries none because the belts are read on their own tab only, not on every
// tab's load. Policy carries none: no store holds a policy version yet, and a
// zero would say none exists.
import { useLocale, useTranslations } from "next-intl";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { TOOLS_TABS, type ToolsAt, type ToolsTab, toolsLink } from "./view";

export function ToolsTabs({
  at,
  current,
  versions,
  providers,
  switchesOn,
  switchesOnIsFloor,
}: {
  at: ToolsAt;
  current: ToolsTab;
  /** The registry's first page: how many versions, and whether that is all. */
  versions: { count: number; complete: boolean };
  /** How many providers the roster holds, or null when it did not answer. */
  providers: number | null;
  /** How many switches are denying, or null when the read did not answer. */
  switchesOn: number | null;
  /** True when the board was truncated, so the count is a floor. */
  switchesOnIsFloor: boolean;
}) {
  const t = useTranslations("tools.tabs");
  const locale = useLocale();
  const count = (tab: ToolsTab): { text: string; tone?: string } | null => {
    switch (tab) {
      case "tools":
        return {
          text: versions.complete
            ? formatCount(versions.count, locale)
            : t("atLeast", { count: versions.count }),
        };
      case "providers":
        return providers === null
          ? null
          : { text: formatCount(providers, locale) };
      case "switches":
        if (switchesOn === null) return null;
        return {
          text: switchesOnIsFloor
            ? t("switchesOnAtLeast", { count: switchesOn })
            : t("switchesOn", { count: switchesOn }),
          ...(switchesOn > 0 ? { tone: "text-error-ink" } : {}),
        };
      case "toolbelts":
      case "policy":
        return null;
    }
  };
  return (
    <div className="min-w-0 overflow-x-auto border-b border-border">
      <div
        role="tablist"
        aria-label={t("label")}
        className="flex w-max min-w-full gap-0.5"
      >
        {TOOLS_TABS.map((tab) => {
          const n = count(tab);
          return (
            <SafeLink
              key={tab}
              id={`tools-tab-${tab}`}
              role="tab"
              to={toolsLink(at, { tab })}
              data-tab={tab}
              aria-selected={tab === current}
              aria-controls={tab === current ? `tools-panel-${tab}` : undefined}
              aria-current={tab === current ? "page" : undefined}
              className={tabLink}
            >
              {t(tab)}
              {n === null ? null : (
                <span
                  data-count={tab}
                  className={`${tabCount} ${n.tone ?? ""}`}
                >
                  {n.text}
                </span>
              )}
            </SafeLink>
          );
        })}
      </div>
    </div>
  );
}
