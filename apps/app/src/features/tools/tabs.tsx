// The Tool servers tab's three views. The Agents page absorbed the Tools page,
// and its tab strip names five tabs (Agents, Tool servers, Policies, Runtimes,
// Off switches). The tool registry and the toolbelts carry no tab of their
// own: they are views of Tool servers, beside the servers list, so the chain
// the Tools page made readable (Provider → Tool → Toolbelt → Agent) stays one
// click apart. The row is links marked with `aria-current`, drawn smaller than
// the tab strip so it reads as part of the tab, not a second row of tabs.
//
// Each count is one the record can stand behind. Servers counts the roster.
// Tools counts the versions of the registry's first page, with a plus when a
// later page exists, because the read carries no total. Toolbelts carries none
// because the belts are read on their own view only.
import { useLocale, useTranslations } from "next-intl";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { type ToolsAt, type ToolsTab, toolsLink } from "./view";

/** The Tool servers views, in the order the row draws them. */
const SERVER_VIEWS = ["providers", "tools", "toolbelts"] as const;
type ServerView = (typeof SERVER_VIEWS)[number];

export function isServerView(tab: ToolsTab): tab is ServerView {
  return SERVER_VIEWS.some((view) => view === tab);
}

const pill =
  "inline-flex min-h-7 max-md:min-h-11 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const pillIdle =
  "border-border text-muted-foreground hover:bg-hl hover:text-foreground";
const pillCurrent = "border-foreground/30 bg-hl text-foreground";

export function ServerViews({
  at,
  current,
  versions,
  providers,
}: {
  at: ToolsAt;
  current: ServerView;
  /** The registry's first page: how many versions, and whether that is all. */
  versions: { count: number; complete: boolean } | null;
  /** How many providers the roster holds, or null when it did not answer. */
  providers: number | null;
}) {
  const t = useTranslations("tools.views");
  const locale = useLocale();
  const count = (view: ServerView): string | null => {
    switch (view) {
      case "providers":
        return providers === null ? null : formatCount(providers, locale);
      case "tools":
        if (versions === null) return null;
        return versions.complete
          ? formatCount(versions.count, locale)
          : t("atLeast", { count: versions.count });
      case "toolbelts":
        return null;
    }
  };
  return (
    <nav aria-label={t("label")} className="flex flex-wrap gap-1.5">
      {SERVER_VIEWS.map((view) => {
        const n = count(view);
        const here = view === current;
        return (
          <SafeLink
            key={view}
            to={toolsLink(at, { tab: view })}
            data-view={view}
            aria-current={here ? "page" : undefined}
            className={`${pill} ${here ? pillCurrent : pillIdle}`}
          >
            {t(view)}
            {n === null ? null : (
              <span data-count={view} className="text-muted-foreground">
                {n}
              </span>
            )}
          </SafeLink>
        );
      })}
    </nav>
  );
}
