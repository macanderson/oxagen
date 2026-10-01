// The eight tabs of the agent page (spec pages/agent.md, Tabs). Each is a
// route segment, so a tab is linkable and the back button moves between tabs.
// The strip is a `RouteTabs` row (ADR-NEW-route-tabs-are-tabs): a tablist of
// links with one tab stop and the arrow keys, scrolling in its own row on a
// phone. The selected tab names the panel the page draws (`AGENT_PANEL`).
//
// The counts are live and read from the record: the Toolbelt count is the
// belt's width, Permissions the mandates in effect, Activity the tamper
// incidents. A count of zero, or one the page could not read, draws nothing.
import { useTranslations } from "next-intl";
import { routes } from "@/shared/safe-path";
import { RouteTabs } from "@/ui/route-tabs";
import { AGENT_TABS, type AgentTab } from "./agent-reads";

/** The id of the panel the agent page draws under the strip. */
export const AGENT_PANEL = "agent-panel";

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
    <RouteTabs
      label={t("label")}
      panel={AGENT_PANEL}
      tabs={AGENT_TABS.map((tab) => {
        const count = counts[tab];
        return {
          to: routes.agent(org, ws, agent, { tab }),
          label: t(tab),
          current: tab === selected,
          name: tab,
          ...(count === undefined || count === null || count === 0
            ? {}
            : {
                count: (
                  <span data-testid={`tab-count-${tab}`}>{count}</span>
                ),
              }),
        };
      })}
    />
  );
}
