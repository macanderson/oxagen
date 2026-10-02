// The MCP servers tab's three views. The Agents page absorbed the Tools page,
// and its tab strip names five tabs (Agents, MCP servers, Policies, Runtimes,
// Off switches). The tool registry and the toolbelts carry no tab of their
// own: they are views of MCP servers, beside the servers list, so the chain
// the Tools page made readable (Provider → Tool → Toolbelt → Agent) stays one
// click apart. The row is a `RouteTabs` row in the `pill` look
// (ADR-243): a tablist with one tab stop and the arrow
// keys, drawn smaller than the tab strip so it reads as part of the tab. The
// selected view names the panel the MCP servers tab draws under the row
// (`SERVER_VIEW_PANEL`).
//
// Each count is one the record can stand behind. Servers counts the roster.
// Tools counts the versions of the registry's first page, with a plus when a
// later page exists, because the read carries no total. Toolbelts carries none
// because the belts are read on their own view only.
import { useLocale, useTranslations } from "next-intl";
import { formatCount } from "@/ui/money-format";
import { RouteTabs } from "@/ui/route-tabs";
import { type ToolsAt, type ToolsTab, toolsLink } from "./view";

/** The MCP servers views, in the order the row draws them. */
const SERVER_VIEWS = ["providers", "tools", "toolbelts"] as const;
type ServerView = (typeof SERVER_VIEWS)[number];

/** The id of the panel a view's body draws in, under the row. */
export const SERVER_VIEW_PANEL = "server-view-panel";

export function isServerView(tab: ToolsTab): tab is ServerView {
  return SERVER_VIEWS.some((view) => view === tab);
}

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
    <RouteTabs
      label={t("label")}
      panel={SERVER_VIEW_PANEL}
      look="pill"
      tabs={SERVER_VIEWS.map((view) => {
        const n = count(view);
        return {
          to: toolsLink(at, { tab: view }),
          label: t(view),
          current: view === current,
          name: view,
          ...(n === null ? {} : { count: <span data-count={view}>{n}</span> }),
        };
      })}
    />
  );
}
