// The eight tabs of the agent page (spec pages/agent.md, Tabs). Each is a
// route segment, so a tab is linkable and the back button moves between tabs.
// The strip is a `tablist` of links, each a `tab` with `aria-selected`, as the
// design's `.tabs` is; it scrolls in its own row on a phone and the selected
// tab carries `aria-current` too, which is what a link list announces.
//
// The counts are live and read from the record: the Toolbelt count is the
// belt's width, Permissions the mandates in effect, Activity the tamper
// incidents. A count of zero, or one the page could not read, draws nothing.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { tabCount, tabLink } from "@/ui/route-tabs";
import { SafeLink } from "@/ui/navigation";
import { AGENT_TABS, type AgentTab } from "./agent-reads";

export type TabCounts = Partial<Record<AgentTab, number | null>>;

export function AgentTabs({
  selected,
  counts,
  org,
  ws,
  agent,
}: {
  selected: AgentTab;
  counts: TabCounts;
  org: string;
  ws: string;
  /** The agent's slug. */
  agent: string;
}) {
  const t = useTranslations("agents.detail.tabs");
  return (
    <div className="min-w-0 overflow-x-auto border-b border-border">
      <div
        role="tablist"
        aria-label={t("label")}
        className="flex w-max min-w-full gap-0.5"
      >
        {AGENT_TABS.map((tab) => {
          const count = counts[tab];
          const current = tab === selected;
          return (
            <SafeLink
              key={tab}
              to={routes.agent(org, ws, agent, { tab })}
              role="tab"
              aria-selected={current}
              aria-current={current ? "page" : undefined}
              data-tab={tab}
              className={tabLink}
            >
              {t(tab)}
              {count === undefined || count === null || count === 0 ? null : (
                <span className={tabCount} data-testid={`tab-count-${tab}`}>
                  {count}
                </span>
              )}
            </SafeLink>
          );
        })}
      </div>
    </div>
  );
}
